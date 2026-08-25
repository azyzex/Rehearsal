import * as fs from 'node:fs';
import * as path from 'node:path';
import { Browser, ConsoleMessage, Page, chromium } from 'playwright';
import { HtmlOptions } from '../../panel/html';

/**
 * A webview, in a real browser.
 *
 * Every other test in this suite reads the webview scripts as text. That was
 * enough to catch a script calling `acquireVsCodeApi()` twice, and not nearly
 * enough to catch what came before it: a drawer that never opened because a
 * card stopped its own click from propagating, and a Drop button rendered red
 * on red so the word "Drop" was invisible until you hovered. Both of those are
 * facts about a rendered page, and no amount of reading the source finds them.
 *
 * So the page is rendered. The markup is the markup the editor loads, the CSS
 * and the scripts are loaded from `media/` exactly as the editor loads them,
 * and the only things faked are the two seams a webview has with its host:
 * `acquireVsCodeApi()`, and the messages the extension posts in.
 *
 * Every fragment that runs inside the page is written as a string rather than
 * as a TypeScript arrow function. That is deliberate twice over: this code runs
 * in a browser and not in the extension's runtime, and writing it as a string
 * says so — and the bundler this project compiles tests with rewrites function
 * names, which quietly breaks anything Playwright has to serialise.
 *
 * What this cannot do is worth being clear about. It is not VS Code: the theme
 * variables are stand-ins for a real one, there is no extension host, and
 * nothing here proves the extension posts the messages these tests send it.
 * It proves that when those messages arrive, the page does what it should.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MEDIA = path.join(ROOT, 'media');
export const SHOTS = path.join(ROOT, 'ui-shots');

/**
 * Stand-ins for the theme variables VS Code injects.
 *
 * Taken from Dark+ so that a contrast check means something. A page rendered
 * with no variables at all exercises only the fallbacks, which is the one case
 * the real editor never produces.
 */
const THEME = `
:root {
  color-scheme: dark;
  --vscode-font-family: system-ui, sans-serif;
  --vscode-editor-font-family: Consolas, monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-panel-border: #2b2b2b;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: #454545;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #0078d4;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-textLink-foreground: #4daafc;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-orange: #d18616;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-green: #89d185;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-purple: #b180d7;
  --vscode-errorForeground: #f85149;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
}
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); }
`;

/** The host seam, installed before any of the panel's own scripts run. */
const VSCODE_SHIM = `
  window.__posted = [];
  window.__state = undefined;
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) { window.__posted.push(message); },
      setState: function (value) { window.__state = value; },
      getState: function () { return window.__state; }
    };
  };
`;

let browser: Browser | undefined;

async function shared(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch();
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

export interface Panel {
  readonly page: Page;
  /** Delivers a message the way the extension would. */
  send(message: unknown): Promise<void>;
  /** Everything the page has posted back, oldest first. */
  posted(): Promise<unknown[]>;
  /** Clicks something and lets the page settle. */
  click(selector: string): Promise<void>;
  /** Saves a PNG under ui-shots/ and returns its path. */
  shot(name: string): Promise<string>;
  /** Anything the page logged as an error, including uncaught exceptions. */
  readonly problems: readonly string[];
  close(): Promise<void>;
}

/**
 * Renders one panel and hands back a handle to drive it.
 *
 * `build` is the panel's own markup function, so what loads here is what the
 * editor loads rather than a copy of it that can drift.
 */
export async function openPanel(
  build: (options: HtmlOptions) => string,
  options: { width?: number; height?: number } = {},
): Promise<Panel> {
  // Written into media/ so the relative hrefs in the markup resolve to the
  // real stylesheet and the real scripts.
  const file = path.join(MEDIA, `__ui-${process.pid}-${Math.random().toString(36).slice(2)}.html`);
  const html = build({
    media: (name) => name,
    nonce: 'test',
    // No CSP outside the editor: a file:// page has no origin, so the editor's
    // policy would block the very files under test.
    cspSource: '',
  }).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<style>${THEME}</style>`);

  fs.writeFileSync(file, html, 'utf8');

  const page = await (await shared()).newPage();
  await page.setViewportSize({ width: options.width ?? 980, height: options.height ?? 760 });

  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      problems.push(`console error: ${message.text()}`);
    }
  });

  // In place before navigation, which is the whole point: the panel's script
  // calls acquireVsCodeApi on its first line.
  await page.addInitScript({ content: VSCODE_SHIM });
  await page.goto(`file://${file.replace(/\\/g, '/')}`);

  const settle = async (): Promise<void> => {
    await page.evaluate(
      'new Promise(function (resolve) { requestAnimationFrame(function () { resolve(null); }); })',
    );
  };

  return {
    page,

    send: async (message: unknown) => {
      await page.evaluate(
        `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} }))`,
      );
      await settle();
    },

    posted: () => page.evaluate('window.__posted') as Promise<unknown[]>,

    click: async (selector: string) => {
      await page.click(selector);
      await settle();
    },

    shot: async (name: string) => {
      fs.mkdirSync(SHOTS, { recursive: true });
      const target = path.join(SHOTS, `${name}.png`);
      await page.screenshot({ path: target, fullPage: true });
      return target;
    },

    problems,

    close: async () => {
      await page.close();
      fs.rmSync(file, { force: true });
    },
  };
}

/**
 * Whether an element's text can actually be read against its own background.
 *
 * This exists because of a real bug: a Drop button whose danger style set the
 * background and lost the fight for the colour, so the word "Drop" was red on
 * red and appeared only on hover. Every static check passed.
 *
 * Returns a WCAG contrast ratio: 1 is invisible, 21 is black on white, and
 * anything under about 3 is unreadable at the size these panels use.
 */
export async function contrast(page: Page, selector: string): Promise<number> {
  return page.evaluate(`
    (function () {
      var element = document.querySelector(${JSON.stringify(selector)});
      if (!element) { throw new Error('no element matching ' + ${JSON.stringify(selector)}); }

      function parse(value) {
        var parts = (value.match(/[\\d.]+/g) || []).map(Number);
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
      }

      // Walks up for the first ancestor that actually paints, which is what
      // the eye sees behind text on a transparent element.
      function backgroundOf(node) {
        var current = node;
        while (current) {
          var rgba = parse(getComputedStyle(current).backgroundColor);
          if (rgba[3] > 0) { return rgba; }
          current = current.parentElement;
        }
        return [31, 31, 31, 1];
      }

      function channel(value) {
        var scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
      }
      function luminance(rgb) {
        return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
      }

      var front = luminance(parse(getComputedStyle(element).color));
      var back = luminance(backgroundOf(element));
      return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
    })()
  `) as Promise<number>;
}

/** Whether the element is on the page and actually takes up space. */
export async function visible(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(`
    (function () {
      var element = document.querySelector(${JSON.stringify(selector)});
      if (!element) { return false; }
      var box = element.getBoundingClientRect();
      var style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 &&
             style.visibility !== 'hidden' && style.display !== 'none' &&
             Number(style.opacity) > 0.05;
    })()
  `) as Promise<boolean>;
}

/** How many elements match, for asserting a list rendered at all. */
export async function count(page: Page, selector: string): Promise<number> {
  return page.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  ) as Promise<number>;
}

/** The trimmed text of everything matching, in document order. */
export async function texts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(`
    Array.prototype.map.call(
      document.querySelectorAll(${JSON.stringify(selector)}),
      function (element) { return (element.textContent || '').trim(); }
    )
  `) as Promise<string[]>;
}
