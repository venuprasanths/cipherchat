const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// ============ POSTGRESQL CONNECTION (Singapore Region) ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
});

// Test connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
        process.exit(1);
    }
    console.log('✅ PostgreSQL connected (Singapore region)');
    release();
});

// File upload setup
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
            await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
            res.json({ success: true, user });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Signup
app.post('/api/signup', async (req, res) => {
    const { name, email, password, phone } = req.body;
    
    if (!name || !email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Invalid input' });
    }
    
    try {
        const result = await pool.query(
            'INSERT INTO users (name, email, password, phone) VALUES ($1, $2, $3, $4) RETURNING id, name, email',
            [name, email, password, phone || null]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            res.status(400).json({ error: 'Email already exists' });
        } else {
            console.error(err);
            res.status(500).json({ error: 'Server error' });
        }
    }
});

// Get all users except current
app.get('/api/users/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, avatar, is_private FROM users WHERE id != $1',
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.json([]);
    }
});

// Get messages
app.get('/api/all-messages/:userId/:contactId', async (req, res) => {
    const { userId, contactId } = req.params;
    
    try {
        const result = await pool.query(
            `SELECT * FROM messages 
             WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
             AND deleted_for_sender = FALSE AND deleted_for_receiver = FALSE
             ORDER BY timestamp ASC`,
            [userId, contactId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.json([]);
    }
});

// Send message
app.post('/api/send-message', async (req, res) => {
    const { from, to, message, isFile, fileName } = req.body;
    
    try {
        const result = await pool.query(
            `INSERT INTO messages (from_user, to_user, encrypted_message, is_file, file_name)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [from, to, message, isFile || false, fileName || null]
        );
        res.json({ success: true, message: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Delete message
app.post('/api/delete-message', async (req, res) => {
    const { messageId, userId } = req.body;
    
    try {
        const result = await pool.query(
            'SELECT from_user, to_user FROM messages WHERE id = $1',
            [messageId]
        );
        
        const msg = result.rows[0];
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        
        if (msg.from_user === userId) {
            await pool.query('UPDATE messages SET deleted_for_sender = TRUE WHERE id = $1', [messageId]);
        } else if (msg.to_user === userId) {
            await pool.query('UPDATE messages SET deleted_for_receiver = TRUE WHERE id = $1', [messageId]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// Upload file
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        res.json({ success: true, fileUrl: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
    } else {
        res.status(400).json({ error: 'No file uploaded' });
    }
});

// Serve pages
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
    console.log(`🌍 Database: Singapore (ap-southeast-1)`);
    console.log(`📡 Perfect for 300-1000 km distances!\n`);
});