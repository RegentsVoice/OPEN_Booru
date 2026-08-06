import fs from 'fs';
import path from 'path';
import {
    logger, st
} from '../config.js';
import {
    saveUserDatabases, cleanupOrphanedTags
} from '../db/index.js';

export function registerGalleryRoutes(app) {
app.get('/api/media', (req, res) => {
    try {
        const db = req.db;
        const page = parseInt(req.query.page) || 0;
        const limit = parseInt(req.query.limit) || 27;
        const tagsFilter = req.query.tags || '';
        const favoriteOnly = req.query.favorite === 'true';
        const type = req.query.type || 'all';

        let whereClauses = [];
        let params = [];
        if (favoriteOnly) {
            whereClauses.push(`m.id IN (SELECT media_id FROM favorites)`);
        }
        if (type !== 'all') {
            whereClauses.push(`m.media_type = ?`);
            params.push(type);
        }

        let mediaIdsWithTags = null;
        if (tagsFilter.trim()) {
            const tagList = tagsFilter.trim().split(/\s+/).filter(t => t);
            let subQuery = `SELECT media_id FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE t.name IN (${tagList.map(() => '?').join(',')}) GROUP BY media_id HAVING COUNT(DISTINCT t.id) = ?`;
            const stmt = db.tags.prepare(subQuery);
            const args = [...tagList, tagList.length];
            stmt.bind(args);
            const ids = [];
            while (stmt.step()) {
                ids.push(stmt.get()[0]);
            }
            stmt.free();
            if (ids.length === 0) {
                return res.json({
                    success: true,
                    posts: [],
                    totalCount: 0,
                    totalPages: 0,
                    currentPage: page
                });
            }
            mediaIdsWithTags = ids;
        }

        if (mediaIdsWithTags) {
            whereClauses.push(`m.id IN (${mediaIdsWithTags.map(() => '?').join(',')})`);
            params.push(...mediaIdsWithTags);
        }

        const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const orderSql = `ORDER BY m.created_at DESC`;

        const countSql = `SELECT COUNT(*) as total FROM media m ${whereSql}`;
        const countStmt = db.main.prepare(countSql);
        if (params.length > 0) countStmt.bind(params);
        let totalCount = 0;
        if (countStmt.step()) totalCount = countStmt.get()[0];
        countStmt.free();

        const dataSql = `SELECT m.* FROM media m ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;
        const dataStmt = db.main.prepare(dataSql);
        const allParams = [...params, limit, page * limit];
        if (allParams.length > 0) dataStmt.bind(allParams);

        const posts = [];
        while (dataStmt.step()) {
            const row = dataStmt.get();
            const columns = dataStmt.getColumnNames();
            const post = {};
            for (let i = 0; i < columns.length; i++) post[columns[i]] = row[i];

            delete post.encryption_iv;

            const tagStmt = db.tags.prepare(`SELECT t.name FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id = ?`);
            tagStmt.bind([post.id]);
            const tags = [];
            while (tagStmt.step()) tags.push(tagStmt.get()[0]);
            tagStmt.free();
            post.tags = tags;

            post.file_url = `/media/${post.file_hash}`;

            const posterStmt = db.previews.prepare(`SELECT 1 FROM previews WHERE media_id = ?`);
            posterStmt.bind([post.id]);
            const hasPoster = posterStmt.step();
            posterStmt.free();
            post.poster_url = hasPoster ? `/poster/${post.file_hash}?t=${post.created_at || Date.now()}` : null;

            const favStmt = db.main.prepare(`SELECT 1 FROM favorites WHERE media_id = ?`);
            favStmt.bind([post.id]);
            post.is_favorite = favStmt.step();
            favStmt.free();

            posts.push(post);
        }
        dataStmt.free();

        res.json({
            success: true,
            posts,
            totalCount,
            totalPages: Math.ceil(totalCount / limit),
            currentPage: page
        });
    } catch (err) {
        logger.error(`Media list error: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message,
            posts: [],
            totalCount: 0,
            totalPages: 0,
            currentPage: 0
        });
    }
});

app.put('/api/media/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const { tags, displayName, description } = req.body;
    const db = req.db;
    try {
        if (displayName !== undefined) db.main.run(`UPDATE media SET display_name = ? WHERE id = ?`, [displayName, id]);
        if (description !== undefined) db.main.run(`UPDATE media SET description = ? WHERE id = ?`, [description, id]);
        if (tags !== undefined) {
            db.tags.run(`DELETE FROM media_tags WHERE media_id = ?`, [id]);
            const tagsList = tags.trim() ? tags.trim().split(/\s+/).filter(t => t) : [];
            const uniqueTags = [...new Set(tagsList.map(t => String(t).trim()).filter(Boolean))];
            for (const tagName of uniqueTags) {
                let tagId = null;
                const tagStmt = db.tags.prepare(`SELECT id FROM tags WHERE name = ?`);
                tagStmt.bind([tagName]);
                if (tagStmt.step()) tagId = tagStmt.get()[0];
                tagStmt.free();
                if (!tagId) {
                    db.tags.run(`INSERT INTO tags (name) VALUES (?)`, [tagName]);
                    tagId = db.tags.exec(`SELECT last_insert_rowid()`)[0].values[0][0];
                }
                db.tags.run(`INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)`, [id, tagId]);
            }
            cleanupOrphanedTags(db.tags);
        }
        saveUserDatabases(db.dbBid);
        res.json({ success: true });
    } catch (err) {
        logger.error(`Update media ${id} error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/media/:id/favorite', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const db = req.db;
    try {
        const stmt = db.main.prepare(`SELECT 1 FROM favorites WHERE media_id = ?`);
        stmt.bind([id]);
        const exists = stmt.step();
        stmt.free();
        if (exists) {
            db.main.run(`DELETE FROM favorites WHERE media_id = ?`, [id]);
            saveUserDatabases(db.dbBid);
            res.json({ success: true, is_favorite: false });
        } else {
            db.main.run(`INSERT INTO favorites (media_id, added_at) VALUES (?, ?)`, [id, Date.now()]);
            saveUserDatabases(db.dbBid);
            res.json({ success: true, is_favorite: true });
        }
    } catch (err) {
        logger.error(`Favorite toggle error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/media/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const db = req.db;
    try {

        const stmt = db.main.prepare(`SELECT container_name, file_hash FROM media WHERE id = ?`);
        stmt.bind([id]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ success: false, error: 'Not found' });
        }
        const row = stmt.get();
        stmt.free();
        const containerName = row[0];
        const fileHash = row[1];

        const containerPath = path.join(db.mediaDir, containerName);
        try { fs.unlinkSync(containerPath); } catch (e) {}
        if (fileHash) {
            const posterPath = path.join(db.mediaDir, `poster_${fileHash}.jpg`);
            try { fs.unlinkSync(posterPath); } catch (e) {}
        }

        db.main.run(`DELETE FROM favorites WHERE media_id = ?`, [id]);
        db.main.run(`DELETE FROM media WHERE id = ?`, [id]);
        db.tags.run(`DELETE FROM media_tags WHERE media_id = ?`, [id]);
        db.previews.run(`DELETE FROM previews WHERE media_id = ?`, [id]);
        cleanupOrphanedTags(db.tags);

        try { db.main.exec('VACUUM'); } catch (e) { logger.warn(`VACUUM main: ${e.message}`); }
        try { db.tags.exec('VACUUM'); } catch (e) { logger.warn(`VACUUM tags: ${e.message}`); }
        try { db.previews.exec('VACUUM'); } catch (e) { logger.warn(`VACUUM previews: ${e.message}`); }

        saveUserDatabases(db.dbBid);
        logger.info(st('mediaDeleted', { id }));
        res.json({ success: true });
    } catch (err) {
        logger.error(st('deleteError', { id, error: err.message }));
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/tags', (req, res) => {
    try {
        const db = req.db;
        const tagsDb = db && db.tags;
        if (!tagsDb) return res.status(500).json({ success: false, error: 'Tags DB not loaded' });
        const q = String(req.query.q || req.query.search || '').trim().toLowerCase();
        const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
        const rows = [];
        if (q) {
            const stmt = tagsDb.prepare(`
                SELECT t.id, t.name, COUNT(mt.media_id) as cnt
                FROM tags t
                LEFT JOIN media_tags mt ON mt.tag_id = t.id
                WHERE lower(t.name) LIKE ?
                GROUP BY t.id
                ORDER BY cnt DESC, t.name ASC
                LIMIT ?
            `);
            stmt.bind(['%' + q + '%', limit]);
            while (stmt.step()) {
                const r = stmt.get();
                rows.push({ id: r[0], name: r[1], count: r[2] });
            }
            stmt.free();
        } else {
            const stmt = tagsDb.prepare(`
                SELECT t.id, t.name, COUNT(mt.media_id) as cnt
                FROM tags t
                LEFT JOIN media_tags mt ON mt.tag_id = t.id
                GROUP BY t.id
                ORDER BY cnt DESC, t.name ASC
                LIMIT ?
            `);
            stmt.bind([limit]);
            while (stmt.step()) {
                const r = stmt.get();
                rows.push({ id: r[0], name: r[1], count: r[2] });
            }
            stmt.free();
        }
        res.json({ success: true, tags: rows });
    } catch (err) {
        logger.error(`GET /api/tags: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/tags/:id', (req, res) => {
    try {
        const db = req.db;
        const tagsDb = db && db.tags;
        if (!tagsDb) return res.status(500).json({ success: false, error: 'Tags DB not loaded' });
        const id = parseInt(req.params.id, 10);
        const newName = String(req.body?.name || '').trim().toLowerCase();
        if (!id || !newName) return res.status(400).json({ success: false, error: 'Invalid name' });

        const cur = tagsDb.prepare(`SELECT id, name FROM tags WHERE id = ?`);
        cur.bind([id]);
        if (!cur.step()) {
            cur.free();
            return res.status(404).json({ success: false, error: 'Tag not found' });
        }
        const oldName = cur.get()[1];
        cur.free();

        const exist = tagsDb.prepare(`SELECT id FROM tags WHERE name = ? AND id != ?`);
        exist.bind([newName, id]);
        if (exist.step()) {
            const targetId = exist.get()[0];
            exist.free();
            tagsDb.run(`INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT media_id, ? FROM media_tags WHERE tag_id = ?`, [targetId, id]);
            tagsDb.run(`DELETE FROM media_tags WHERE tag_id = ?`, [id]);
            tagsDb.run(`DELETE FROM tags WHERE id = ?`, [id]);
            cleanupOrphanedTags(tagsDb);
            saveUserDatabases(db.dbBid);
            return res.json({ success: true, merged: true, id: targetId, name: newName });
        }
        exist.free();

        tagsDb.run(`UPDATE tags SET name = ? WHERE id = ?`, [newName, id]);
        saveUserDatabases(db.dbBid);
        res.json({ success: true, id, name: newName, oldName });
    } catch (err) {
        logger.error(`PUT /api/tags: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/tags/:id', (req, res) => {
    try {
        const db = req.db;
        const tagsDb = db && db.tags;
        if (!tagsDb) return res.status(500).json({ success: false, error: 'Tags DB not loaded' });
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
        tagsDb.run(`DELETE FROM media_tags WHERE tag_id = ?`, [id]);
        tagsDb.run(`DELETE FROM tags WHERE id = ?`, [id]);
        cleanupOrphanedTags(tagsDb);
        saveUserDatabases(db.dbBid);
        res.json({ success: true });
    } catch (err) {
        logger.error(`DELETE /api/tags: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/tags/autocomplete', (req, res) => {
    const query = req.query.query || '';
    if (!query) return res.json({ tags: [] });
    const db = req.db;
    try {
        const stmt = db.tags.prepare(`
            SELECT t.name, COUNT(mt.media_id) as count
            FROM tags t
            LEFT JOIN media_tags mt ON mt.tag_id = t.id
            WHERE t.name LIKE ?
            GROUP BY t.id
            ORDER BY t.name
            LIMIT 10
        `);
        stmt.bind([`${query}%`]);
        const tags = [];
        while (stmt.step()) {
            const row = stmt.get();
            tags.push({ name: row[0], count: row[1] });
        }
        stmt.free();
        res.json({ tags });
    } catch (err) {
        logger.error(st('autocompleteError', { error: err.message }));
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/search/history', (req, res) => {
    const { query, results_count } = req.body;
    if (!query) return res.status(400).json({ success: false });
    const db = req.db;
    try {
        db.main.run(`INSERT INTO search_history (query, timestamp, results_count) VALUES (?, ?, ?)`, [query, Date.now(), results_count || 0]);
        res.json({ success: true });
    } catch (err) {
        logger.error(`Search history error: ${err.message}`);
        res.status(500).json({ success: false });
    }
});

app.get('/api/search/history', (req, res) => {
    const db = req.db;
    try {
        const stmt = db.main.prepare(`SELECT query, timestamp, results_count FROM search_history ORDER BY timestamp DESC LIMIT 20`);
        const history = [];
        while (stmt.step()) {
            const row = stmt.get();
            history.push({ query: row[0], timestamp: row[1], results_count: row[2] });
        }
        stmt.free();
        res.json({ history });
    } catch (err) {
        logger.error(`Search history fetch error: ${err.message}`);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/stats', (req, res) => {
    const db = req.db;
    try {
        const mediaCount = db.main.exec(`SELECT COUNT(*) FROM media`)[0].values[0][0];
        const tagCount = db.tags.exec(`SELECT COUNT(*) FROM tags`)[0].values[0][0];
        const favCount = db.main.exec(`SELECT COUNT(*) FROM favorites`)[0].values[0][0];
        const searchCount = db.main.exec(`SELECT COUNT(*) FROM search_history`)[0].values[0][0];
        res.json({ mediaCount, tagCount, favCount, searchCount });
    } catch (err) {
        logger.error(`Stats error: ${err.message}`);
        res.status(500).json({ error: 'Internal error' });
    }
});

}
