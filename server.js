const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const VOTE_COOKIE_NAME = 'rosta_vote';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'För många begäranden, försök igen om en minut' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/vote', voteLimiter);

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        option_key VARCHAR(10) NOT NULL CHECK (option_key IN ('ja', 'nej', 'vetej')),
        voter_hash VARCHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_votes_option ON votes(option_key);
      CREATE INDEX IF NOT EXISTS idx_votes_hash ON votes(voter_hash);
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

function generateVoterHash(req) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const ua = req.get('user-agent') || 'unknown';
  const combined = `${ip}|${ua}`;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function getExistingVote(req) {
  return req.cookies[VOTE_COOKIE_NAME] || null;
}

function setVoteCookie(res, option) {
  res.cookie(VOTE_COOKIE_NAME, option, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

function clearVoteCookie(res) {
  res.clearCookie(VOTE_COOKIE_NAME, { path: '/' });
}

app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT option_key, COUNT(*) as count
      FROM votes
      GROUP BY option_key
    `);
    const votes = { ja: 0, nej: 0, vetej: 0 };
    let total = 0;
    result.rows.forEach(row => {
      votes[row.option_key] = parseInt(row.count);
      total += parseInt(row.count);
    });
    const percentages = {};
    ['ja', 'nej', 'vetej'].forEach(key => {
      percentages[key] = total > 0 ? Math.round((votes[key] / total) * 100) : 0;
    });
    res.json({ votes, percentages, total });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Kunde inte hämta statistik' });
  }
});

app.get('/api/my-vote', (req, res) => {
  const existingVote = getExistingVote(req);
  res.json({ vote: existingVote });
});

app.post('/api/vote', async (req, res) => {
  try {
    const { option } = req.body;
    const validOptions = ['ja', 'nej', 'vetej'];
    
    if (!option || !validOptions.includes(option)) {
      return res.status(400).json({ error: 'Ogiltigt alternativ' });
    }

    const existingVote = getExistingVote(req);
    const voterHash = generateVoterHash(req);

    const existingDbVote = await pool.query(
      'SELECT option_key FROM votes WHERE voter_hash = $1',
      [voterHash]
    );

    if (existingDbVote.rows.length > 0) {
      const dbVote = existingDbVote.rows[0].option_key;
      if (dbVote !== option) {
        await pool.query(
          'UPDATE votes SET option_key = $1, created_at = NOW() WHERE voter_hash = $2',
          [option, voterHash]
        );
        setVoteCookie(res, option);
        return res.json({ success: true, changed: true, vote: option });
      }
      return res.json({ success: true, changed: false, vote: option });
    }

    if (existingVote && existingVote !== option) {
      await pool.query(
        'DELETE FROM votes WHERE voter_hash = $1',
        [voterHash]
      );
    }

    await pool.query(
      'INSERT INTO votes (option_key, voter_hash) VALUES ($1, $2)',
      [option, voterHash]
    );

    setVoteCookie(res, option);
    res.json({ success: true, changed: false, vote: option });
  } catch (err) {
    console.error('Vote error:', err);
    res.status(500).json({ error: 'Kunde inte registrera röst' });
  }
});

app.post('/api/vote/remove', async (req, res) => {
  try {
    const voterHash = generateVoterHash(req);
    await pool.query('DELETE FROM votes WHERE voter_hash = $1', [voterHash]);
    clearVoteCookie(res);
    res.json({ success: true });
  } catch (err) {
    console.error('Remove vote error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort röst' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internt serverfel' });
});

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});