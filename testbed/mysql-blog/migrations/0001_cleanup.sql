-- Staged for v2. Same failure modes as the Postgres testbed, MySQL syntax.

-- Destructive: twitter is populated for most authors.
ALTER TABLE authors DROP COLUMN twitter;

-- Blocking: 12 authors have no email.
ALTER TABLE authors MODIFY email VARCHAR(255) NOT NULL;

-- Blocking: 40 authors share one email address.
ALTER TABLE authors ADD UNIQUE KEY authors_email_key (email);

-- Blocking: 150 posts point at an author that does not exist.
ALTER TABLE posts ADD CONSTRAINT posts_author_fk FOREIGN KEY (author_id) REFERENCES authors (id);

-- Locks the table for the duration of the build on older MySQL versions.
CREATE INDEX idx_comments_post_id ON comments (post_id);

-- Safe: legacy_bio is NULL in every row.
ALTER TABLE authors DROP COLUMN legacy_bio;

-- DML, previewable exactly as in Postgres.
UPDATE posts SET status = 'archived' WHERE published_at < NOW() - INTERVAL 1 YEAR;

DELETE FROM comments WHERE is_spam = 1;
