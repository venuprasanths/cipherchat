const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: true,  // Verify certificate
        sslmode: 'verify-full'     // Full verification (recommended)
    }
});
async function setupDatabase() {
    console.log('🔧 Setting up database tables in Singapore region...');
    
    const sql = `
        -- Users table
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            avatar TEXT DEFAULT '👤',
            phone TEXT,
            is_private BOOLEAN DEFAULT TRUE,
            last_seen TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        -- Messages table (encrypted)
        CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            from_user INTEGER NOT NULL REFERENCES users(id),
            to_user INTEGER NOT NULL REFERENCES users(id),
            encrypted_message TEXT NOT NULL,
            is_file BOOLEAN DEFAULT FALSE,
            file_name TEXT,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            edited BOOLEAN DEFAULT FALSE,
            deleted_for_sender BOOLEAN DEFAULT FALSE,
            deleted_for_receiver BOOLEAN DEFAULT FALSE
        );
        
        -- Reactions table
        CREATE TABLE IF NOT EXISTS reactions (
            id SERIAL PRIMARY KEY,
            message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id),
            reaction TEXT NOT NULL,
            timestamp TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(message_id, user_id)
        );
        
        -- Contact requests table
        CREATE TABLE IF NOT EXISTS contact_requests (
            id SERIAL PRIMARY KEY,
            from_user INTEGER NOT NULL REFERENCES users(id),
            to_user INTEGER NOT NULL REFERENCES users(id),
            status TEXT DEFAULT 'pending',
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(from_user, to_user)
        );
        
        -- Blocked users table
        CREATE TABLE IF NOT EXISTS blocked_users (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            blocked_user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, blocked_user_id)
        );
        
        -- Indexes for performance
        CREATE INDEX IF NOT EXISTS idx_messages_from_user ON messages(from_user, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages(to_user, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_contact_requests_status ON contact_requests(status);
        
        -- Insert demo users (password: 12345678)
        INSERT INTO users (name, email, password, is_private) VALUES 
            ('Alice', 'alice@example.com', '12345678', FALSE),
            ('Bob', 'bob@example.com', '12345678', FALSE)
        ON CONFLICT (email) DO NOTHING;
    `;
    
    try {
        await pool.query(sql);
        console.log('✅ Database tables created successfully!');
        
        // Verify connection and show latency
        const start = Date.now();
        const result = await pool.query('SELECT COUNT(*) as count FROM users');
        const latency = Date.now() - start;
        
        console.log(`📊 Users in database: ${result.rows[0].count}`);
        console.log(`📡 Connection latency: ${latency}ms (Singapore region)`);
        
        if (latency < 80) {
            console.log('✅ Excellent! Perfect for Indian users (300-1000 km)');
        } else if (latency < 150) {
            console.log('✅ Good latency for long distance chat');
        } else {
            console.log('⚠️ Check your internet connection');
        }
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.log('\n💡 Troubleshooting:');
        console.log('1. Check DATABASE_URL in .env file');
        console.log('2. Verify password is correct');
        console.log('3. Make sure region is ap-southeast-1 (Singapore)');
    } finally {
        await pool.end();
    }
}

setupDatabase();