const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// ============ POSTGRESQL CONNECTION ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
        process.exit(1);
    }
    console.log('✅ PostgreSQL connected successfully');
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
    console.log('Login attempt:', email);
    
    try {
        const result = await pool.query(
            'SELECT id, name, email, avatar, is_private FROM users WHERE email = $1 AND password = $2',
            [email, password]
        );
        
        const user = result.rows[0];
        if (user) {
            await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [user.id]);
            console.log('✅ Login successful:', user.name);
            res.json({ success: true, user });
        } else {
            console.log('❌ Login failed: Invalid credentials');
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Signup
app.post('/api/signup', async (req, res) => {
    const { name, email, password, phone } = req.body;
    console.log('Signup attempt:', email);
    
    if (!name || !email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Invalid input' });
    }
    
    try {
        const result = await pool.query(
            'INSERT INTO users (name, email, password, phone, is_private) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email',
            [name, email, password, phone || null, true]
        );
        console.log('✅ User created:', name);
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            res.status(400).json({ error: 'Email already exists' });
        } else {
            console.error('Signup error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    }
});

// Delete account
app.post('/api/delete-account', async (req, res) => {
    const { userId, password } = req.body;
    
    try {
        const user = await pool.query('SELECT id, password FROM users WHERE id = $1', [userId]);
        if (!user.rows[0] || user.rows[0].password !== password) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        await pool.query('DELETE FROM messages WHERE from_user = $1 OR to_user = $1', [userId]);
        await pool.query('DELETE FROM reactions WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM contact_requests WHERE from_user = $1 OR to_user = $1', [userId]);
        await pool.query('DELETE FROM blocked_users WHERE user_id = $1 OR blocked_user_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        
        console.log('🗑️ User deleted:', userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update privacy setting
app.post('/api/update-privacy', async (req, res) => {
    const { userId, isPrivate } = req.body;
    
    try {
        await pool.query('UPDATE users SET is_private = $1 WHERE id = $2', [isPrivate ? 1 : 0, userId]);
        console.log(`🔒 User ${userId} privacy: ${isPrivate ? 'Private' : 'Public'}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Privacy update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get all users except current
app.get('/api/users/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, avatar, is_private FROM users WHERE id != $1', [req.params.userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.json([]);
    }
});

// Get contacts (accepted requests)
app.get('/api/contacts/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        const result = await pool.query(`
            SELECT DISTINCT u.id, u.name, u.avatar, u.is_private
            FROM users u
            WHERE u.id IN (
                SELECT CASE 
                    WHEN cr.from_user = $1 THEN cr.to_user 
                    ELSE cr.from_user 
                END
                FROM contact_requests cr
                WHERE (cr.from_user = $1 OR cr.to_user = $1) AND cr.status = 'accepted'
            )
            AND u.id != $1
        `, [userId]);
        
        console.log(`📋 Contacts for user ${userId}: ${result.rows.length}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Contacts error:', err);
        res.json([]);
    }
});

// Get pending contact requests
app.get('/api/pending-requests/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        const result = await pool.query(`
            SELECT cr.id, cr.from_user, cr.message, cr.created_at, u.name, u.avatar 
            FROM contact_requests cr
            JOIN users u ON cr.from_user = u.id
            WHERE cr.to_user = $1 AND cr.status = 'pending'
            ORDER BY cr.created_at DESC
        `, [userId]);
        
        console.log(`📨 Pending requests for user ${userId}: ${result.rows.length}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Pending requests error:', err);
        res.json([]);
    }
});

// Send contact request
app.post('/api/send-request', async (req, res) => {
    const { fromUserId, toUserId, message } = req.body;
    
    try {
        // Check if request already exists
        const existing = await pool.query(
            'SELECT status FROM contact_requests WHERE from_user = $1 AND to_user = $2',
            [fromUserId, toUserId]
        );
        
        if (existing.rows.length > 0) {
            if (existing.rows[0].status === 'pending') {
                return res.json({ success: false, error: 'Request already sent' });
            }
            if (existing.rows[0].status === 'accepted') {
                return res.json({ success: false, error: 'Already connected' });
            }
            // Update rejected request to pending
            await pool.query(
                'UPDATE contact_requests SET status = $1, message = $2, created_at = NOW() WHERE from_user = $3 AND to_user = $4',
                ['pending', message || '', fromUserId, toUserId]
            );
        } else {
            await pool.query(
                'INSERT INTO contact_requests (from_user, to_user, message, status) VALUES ($1, $2, $3, $4)',
                [fromUserId, toUserId, message || '', 'pending']
            );
        }
        
        console.log(`📨 Contact request sent: ${fromUserId} -> ${toUserId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Send request error:', err);
        res.status(500).json({ error: 'Failed to send request' });
    }
});

// Respond to contact request
app.post('/api/respond-request', async (req, res) => {
    const { requestId, accept } = req.body;
    const status = accept ? 'accepted' : 'rejected';
    
    try {
        await pool.query('UPDATE contact_requests SET status = $1 WHERE id = $2', [status, requestId]);
        console.log(`📨 Request ${requestId} ${status}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Respond request error:', err);
        res.status(500).json({ error: 'Failed to respond' });
    }
});

// Block user
app.post('/api/block-user', async (req, res) => {
    const { userId, blockUserId } = req.body;
    
    try {
        await pool.query('INSERT INTO blocked_users (user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, blockUserId]);
        await pool.query('DELETE FROM contact_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)', [userId, blockUserId]);
        console.log(`🚫 User ${userId} blocked ${blockUserId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Block user error:', err);
        res.status(500).json({ error: 'Failed to block user' });
    }
});

// Unblock user
app.post('/api/unblock-user', async (req, res) => {
    const { userId, blockUserId } = req.body;
    
    try {
        await pool.query('DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2', [userId, blockUserId]);
        console.log(`🔓 User ${userId} unblocked ${blockUserId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Unblock user error:', err);
        res.status(500).json({ error: 'Failed to unblock user' });
    }
});

// Get blocked users
app.get('/api/blocked-users/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        const result = await pool.query(`
            SELECT u.id, u.name, u.avatar 
            FROM blocked_users b
            JOIN users u ON b.blocked_user_id = u.id
            WHERE b.user_id = $1
        `, [userId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Blocked users error:', err);
        res.json([]);
    }
});

// Get discover users (public users not yet connected)
app.get('/api/discover-users/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    
    try {
        // Get blocked users
        const blocked = await pool.query('SELECT blocked_user_id FROM blocked_users WHERE user_id = $1', [userId]);
        const blockedIds = blocked.rows.map(b => b.blocked_user_id);
        
        // Get existing contacts (accepted)
        const contacts = await pool.query(`
            SELECT DISTINCT CASE 
                WHEN from_user = $1 THEN to_user 
                ELSE from_user 
            END as contact_id
            FROM contact_requests
            WHERE (from_user = $1 OR to_user = $1) AND status = 'accepted'
        `, [userId]);
        const contactIds = contacts.rows.map(c => c.contact_id);
        
        // Get pending requests
        const pending = await pool.query(`
            SELECT DISTINCT from_user as user_id FROM contact_requests WHERE to_user = $1 AND status = 'pending'
            UNION
            SELECT DISTINCT to_user as user_id FROM contact_requests WHERE from_user = $1 AND status = 'pending'
        `, [userId]);
        const pendingIds = pending.rows.map(p => p.user_id);
        
        // Combine all IDs to exclude
        const excludeIds = [...blockedIds, ...contactIds, ...pendingIds, userId];
        
        let query = `
            SELECT id, name, avatar, is_private 
            FROM users 
            WHERE id != $1 AND is_private = false
        `;
        
        if (excludeIds.length > 0) {
            query += ` AND id NOT IN (${excludeIds.join(',')})`;
        }
        
        query += ` LIMIT 50`;
        
        const users = await pool.query(query, [userId]);
        console.log(`🔍 Discover users for ${userId}: ${users.rows.length}`);
        res.json(users.rows);
    } catch (err) {
        console.error('Discover error:', err);
        res.json([]);
    }
});

// ============ MESSAGE APIs ============

// Get messages between users
app.get('/api/all-messages/:userId/:contactId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const contactId = parseInt(req.params.contactId);
    
    try {
        // Check if they are contacts
        const areContacts = await pool.query(`
            SELECT id FROM contact_requests WHERE 
            ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)) 
            AND status = 'accepted'
        `, [userId, contactId]);
        
        if (areContacts.rows.length === 0) {
            return res.json([]);
        }
        
        const result = await pool.query(`
            SELECT * FROM messages 
            WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
            AND deleted_for_sender = false AND deleted_for_receiver = false
            ORDER BY timestamp ASC
        `, [userId, contactId]);
        
        // Get reactions
        const reactions = await pool.query('SELECT * FROM reactions');
        const reactionsByMessage = {};
        for (const r of reactions.rows) {
            if (!reactionsByMessage[r.message_id]) reactionsByMessage[r.message_id] = [];
            reactionsByMessage[r.message_id].push({ reaction: r.reaction, user_id: r.user_id });
        }
        
        const messagesWithReactions = result.rows.map(msg => ({
            ...msg,
            reactions: reactionsByMessage[msg.id] || []
        }));
        
        res.json(messagesWithReactions);
    } catch (err) {
        console.error('Messages error:', err);
        res.json([]);
    }
});

// Send message
app.post('/api/send-message', async (req, res) => {
    const { from, to, message, isFile, fileName } = req.body;
    
    try {
        const result = await pool.query(`
            INSERT INTO messages (from_user, to_user, encrypted_message, is_file, file_name, timestamp)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *
        `, [from, to, message, isFile ? 1 : 0, fileName || null]);
        
        console.log(`📨 Message sent: ${from} -> ${to}`);
        res.json({ success: true, message: result.rows[0] });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Delete message (soft delete)
app.post('/api/delete-message', async (req, res) => {
    const { messageId, userId } = req.body;
    
    try {
        const msg = await pool.query('SELECT from_user, to_user FROM messages WHERE id = $1', [messageId]);
        
        if (msg.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }
        
        if (msg.rows[0].from_user === userId) {
            await pool.query('UPDATE messages SET deleted_for_sender = true WHERE id = $1', [messageId]);
        } else if (msg.rows[0].to_user === userId) {
            await pool.query('UPDATE messages SET deleted_for_receiver = true WHERE id = $1', [messageId]);
        }
        
        console.log(`🗑️ Message ${messageId} deleted by user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete message error:', err);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// Edit message
app.post('/api/edit-message', async (req, res) => {
    const { messageId, newMessage, userId } = req.body;
    
    try {
        await pool.query(
            'UPDATE messages SET encrypted_message = $1, edited = true WHERE id = $2 AND from_user = $3 AND is_file = false',
            [newMessage, messageId, userId]
        );
        console.log(`✏️ Message ${messageId} edited`);
        res.json({ success: true });
    } catch (err) {
        console.error('Edit message error:', err);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});

// Add reaction
app.post('/api/add-reaction', async (req, res) => {
    const { messageId, userId, reaction } = req.body;
    
    try {
        // Check if user already reacted with this emoji
        const existing = await pool.query(
            'SELECT id FROM reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3',
            [messageId, userId, reaction]
        );
        
        if (existing.rows.length > 0) {
            // Remove reaction
            await pool.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3', [messageId, userId, reaction]);
        } else {
            // Remove any other reaction from this user
            await pool.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
            // Add new reaction
            await pool.query('INSERT INTO reactions (message_id, user_id, reaction) VALUES ($1, $2, $3)', [messageId, userId, reaction]);
        }
        
        // Get updated reactions
        const updatedReactions = await pool.query('SELECT reaction, user_id FROM reactions WHERE message_id = $1', [messageId]);
        
        console.log(`😊 Reaction on message ${messageId}: ${reaction}`);
        res.json({ success: true, reactions: updatedReactions.rows });
    } catch (err) {
        console.error('Add reaction error:', err);
        res.status(500).json({ error: 'Failed to add reaction' });
    }
});

// Upload file
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        console.log(`📁 File uploaded: ${req.file.originalname}`);
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 CipherChat Server Running`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🌍 Database: Neon PostgreSQL (Singapore)`);
    console.log(`✅ All APIs ready!\n`);
});