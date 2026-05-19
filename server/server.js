const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const CryptoJS = require('crypto-js');
require('dotenv').config();

const app = express();

// ============ ENCRYPTION SETUP ============
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'cipherchat-super-secret-key-2024';

function encryptMessage(message) {
    return CryptoJS.AES.encrypt(message, ENCRYPTION_KEY).toString();
}

function decryptMessage(encryptedMessage) {
    try {
        const bytes = CryptoJS.AES.decrypt(encryptedMessage, ENCRYPTION_KEY);
        return bytes.toString(CryptoJS.enc.Utf8);
    } catch(e) {
        return encryptedMessage;
    }
}

// ============ DATABASE CONNECTION ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database error:', err.message);
        process.exit(1);
    }
    console.log('✅ PostgreSQL connected');
    release();
});

// ============ CREATE TABLES ============
async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            avatar TEXT DEFAULT '👤',
            is_private BOOLEAN DEFAULT FALSE,
            last_seen TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            from_user INTEGER NOT NULL,
            to_user INTEGER NOT NULL,
            encrypted_message TEXT NOT NULL,
            is_file BOOLEAN DEFAULT FALSE,
            file_name TEXT,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            edited BOOLEAN DEFAULT FALSE,
            deleted_for_sender BOOLEAN DEFAULT FALSE,
            deleted_for_receiver BOOLEAN DEFAULT FALSE
        );
        
        CREATE TABLE IF NOT EXISTS contact_requests (
            id SERIAL PRIMARY KEY,
            from_user INTEGER NOT NULL,
            to_user INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(from_user, to_user)
        );
        
        CREATE TABLE IF NOT EXISTS blocked_users (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            blocked_user_id INTEGER NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, blocked_user_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user, timestamp);
        CREATE INDEX IF NOT EXISTS idx_contact_requests_status ON contact_requests(to_user, status);
    `);
    console.log('✅ Tables ready');
}
initDatabase();

// ============ FILE UPLOAD ============
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: storage });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploadDir));

// ============ USER APIs ============

// Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT id, name, email, avatar, is_private FROM users WHERE email = $1 AND password = $2',
            [email, password]
        );
        const user = result.rows[0];
        if (user) {
            // Ensure is_private is boolean
            user.is_private = user.is_private === true || user.is_private === 1;
            await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
            res.json({ success: true, user });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Signup - PUBLIC by default (is_private = false)
app.post('/api/signup', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Invalid input' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO users (name, email, password, is_private) VALUES ($1, $2, $3, $4) RETURNING id, name, email, is_private',
            [name, email, password, false]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            res.status(400).json({ error: 'Email already exists' });
        } else {
            res.status(500).json({ error: 'Server error' });
        }
    }
});

// Update privacy setting
app.post('/api/update-privacy', async (req, res) => {
    const { userId, isPrivate } = req.body;
    try {
        const privateValue = isPrivate === true || isPrivate === 1 || isPrivate === 'true';
        await pool.query('UPDATE users SET is_private = $1 WHERE id = $2', [privateValue, userId]);
        console.log(`User ${userId} privacy updated to: ${privateValue ? 'Private' : 'Public'}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Privacy update error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/:userId', async (req, res) => {
    const result = await pool.query('SELECT id, name, avatar, is_private FROM users WHERE id != $1', [req.params.userId]);
    res.json(result.rows);
});

app.get('/api/contacts/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const result = await pool.query(`
        SELECT DISTINCT u.id, u.name, u.avatar, u.is_private
        FROM users u
        WHERE u.id IN (
            SELECT CASE WHEN cr.from_user = $1 THEN cr.to_user ELSE cr.from_user END
            FROM contact_requests cr
            WHERE (cr.from_user = $1 OR cr.to_user = $1) AND cr.status = 'accepted'
        ) AND u.id != $1
    `, [userId]);
    res.json(result.rows);
});

app.get('/api/pending-requests/:userId', async (req, res) => {
    const result = await pool.query(`
        SELECT cr.id, cr.from_user, cr.message, u.name, u.avatar 
        FROM contact_requests cr
        JOIN users u ON cr.from_user = u.id
        WHERE cr.to_user = $1 AND cr.status = 'pending'
    `, [req.params.userId]);
    res.json(result.rows);
});

app.post('/api/send-request', async (req, res) => {
    const { fromUserId, toUserId, message } = req.body;
    const existing = await pool.query(
        'SELECT status FROM contact_requests WHERE from_user = $1 AND to_user = $2',
        [fromUserId, toUserId]
    );
    if (existing.rows.length > 0 && existing.rows[0].status === 'pending') {
        return res.json({ success: false, error: 'Request already sent' });
    }
    await pool.query(
        'INSERT INTO contact_requests (from_user, to_user, message, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO UPDATE SET status = $4, message = $3',
        [fromUserId, toUserId, message || '', 'pending']
    );
    res.json({ success: true });
});

app.post('/api/respond-request', async (req, res) => {
    const { requestId, accept } = req.body;
    await pool.query('UPDATE contact_requests SET status = $1 WHERE id = $2', [accept ? 'accepted' : 'rejected', requestId]);
    res.json({ success: true });
});

app.post('/api/block-user', async (req, res) => {
    const { userId, blockUserId } = req.body;
    await pool.query('INSERT INTO blocked_users (user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, blockUserId]);
    await pool.query('DELETE FROM contact_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)', [userId, blockUserId]);
    res.json({ success: true });
});

app.post('/api/unblock-user', async (req, res) => {
    const { userId, blockUserId } = req.body;
    await pool.query('DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2', [userId, blockUserId]);
    res.json({ success: true });
});

app.get('/api/blocked-users/:userId', async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.name FROM blocked_users b
        JOIN users u ON b.blocked_user_id = u.id
        WHERE b.user_id = $1
    `, [req.params.userId]);
    res.json(result.rows);
});

app.get('/api/discover-users/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const blocked = await pool.query('SELECT blocked_user_id FROM blocked_users WHERE user_id = $1', [userId]);
    const blockedIds = blocked.rows.map(b => b.blocked_user_id);
    const contacts = await pool.query(`
        SELECT DISTINCT CASE WHEN from_user = $1 THEN to_user ELSE from_user END as contact_id
        FROM contact_requests WHERE (from_user = $1 OR to_user = $1) AND status = 'accepted'
    `, [userId]);
    const contactIds = contacts.rows.map(c => c.contact_id);
    const pending = await pool.query(`
        SELECT from_user as user_id FROM contact_requests WHERE to_user = $1 AND status = 'pending'
        UNION SELECT to_user as user_id FROM contact_requests WHERE from_user = $1 AND status = 'pending'
    `, [userId]);
    const pendingIds = pending.rows.map(p => p.user_id);
    const excludeIds = [...blockedIds, ...contactIds, ...pendingIds, userId];
    let query = 'SELECT id, name, avatar, is_private FROM users WHERE id != $1 AND is_private = false';
    if (excludeIds.length > 0) {
        query += ` AND id NOT IN (${excludeIds.join(',')})`;
    }
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
});

// ============ MESSAGE APIs WITH REAL ENCRYPTION ============

app.get('/api/all-messages/:userId/:contactId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const contactId = parseInt(req.params.contactId);
    
    const result = await pool.query(`
        SELECT * FROM messages 
        WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
        AND deleted_for_sender = false AND deleted_for_receiver = false
        ORDER BY timestamp ASC
    `, [userId, contactId]);
    
    const decryptedMessages = result.rows.map(msg => ({
        id: msg.id,
        from_user: msg.from_user,
        to_user: msg.to_user,
        message: decryptMessage(msg.encrypted_message),
        is_file: msg.is_file,
        file_name: msg.file_name,
        timestamp: msg.timestamp,
        edited: msg.edited
    }));
    
    res.json(decryptedMessages);
});

app.post('/api/send-message', async (req, res) => {
    const { from, to, message, isFile, fileName } = req.body;
    
    const encryptedMsg = encryptMessage(message);
    console.log(`🔐 Message encrypted`);
    
    const result = await pool.query(`
        INSERT INTO messages (from_user, to_user, encrypted_message, is_file, file_name)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [from, to, encryptedMsg, isFile || false, fileName || null]);
    
    res.json({ success: true, message: { ...result.rows[0], message: message } });
});

app.post('/api/delete-message', async (req, res) => {
    const { messageId, userId } = req.body;
    const msg = await pool.query('SELECT from_user, to_user FROM messages WHERE id = $1', [messageId]);
    if (msg.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    if (msg.rows[0].from_user === userId) {
        await pool.query('UPDATE messages SET deleted_for_sender = true WHERE id = $1', [messageId]);
    } else if (msg.rows[0].to_user === userId) {
        await pool.query('UPDATE messages SET deleted_for_receiver = true WHERE id = $1', [messageId]);
    }
    res.json({ success: true });
});

app.post('/api/edit-message', async (req, res) => {
    const { messageId, newMessage, userId } = req.body;
    const encryptedMsg = encryptMessage(newMessage);
    await pool.query('UPDATE messages SET encrypted_message = $1, edited = true WHERE id = $2 AND from_user = $3', [encryptedMsg, messageId, userId]);
    res.json({ success: true });
});

app.post('/api/add-reaction', async (req, res) => {
    const { messageId, userId, reaction } = req.body;
    res.json({ success: true });
});

app.post('/api/delete-account', async (req, res) => {
    const { userId, password } = req.body;
    const user = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (!user.rows[0] || user.rows[0].password !== password) {
        return res.status(401).json({ error: 'Wrong password' });
    }
    await pool.query('DELETE FROM messages WHERE from_user = $1 OR to_user = $1', [userId]);
    await pool.query('DELETE FROM contact_requests WHERE from_user = $1 OR to_user = $1', [userId]);
    await pool.query('DELETE FROM blocked_users WHERE user_id = $1 OR blocked_user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        res.json({ success: true, fileUrl: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
    } else {
        res.status(400).json({ error: 'No file' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'home.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 CipherChat Server Running`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🔐 AES-256 Encryption ACTIVE`);
    console.log(`✅ Default accounts are PUBLIC\n`);
});