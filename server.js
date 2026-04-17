import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const port = Number(process.env.PORT || 3001);
const adminPassword = process.env.ADMIN_PASSWORD || 'mariage2026';
const sessions = new Map();

const mongoUriTemplate = process.env.MONGODB_URI?.trim();
const mongoPassword = process.env.DB_PASSWORD?.trim();

function buildMongoUri() {
  if (!mongoUriTemplate) {
    throw new Error('Missing MONGODB_URI in environment');
  }

  if (mongoUriTemplate.includes('<db_password>')) {
    if (!mongoPassword) {
      throw new Error('Missing DB_PASSWORD in environment');
    }

    return mongoUriTemplate.replace('<db_password>', mongoPassword);
  }

  return mongoUriTemplate;
}

const mongoUri = buildMongoUri();
const mongoClient = new MongoClient(mongoUri);

let guestsCollection;

async function initDatabase() {
  await mongoClient.connect();

  const dbName = mongoClient.options.dbName || 'wedding_plan';
  const db = mongoClient.db(dbName);
  guestsCollection = db.collection('guests');

  await Promise.all([
    guestsCollection.createIndex({ id: 1 }, { unique: true }),
    guestsCollection.createIndex({ qrCode: 1 }, { unique: true }),
    guestsCollection.createIndex({ createdAt: -1 }),
  ]);
}

function sendJson(res, statusCode, payload, origin = '*') {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(payload));
}

function getOrigin(req) {
  return req.headers.origin || '*';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function getToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice('Bearer '.length).trim();
}

function requireAuth(req, res, origin) {
  const token = getToken(req);
  if (!token || !sessions.has(token)) {
    sendJson(res, 401, { error: 'Unauthorized' }, origin);
    return null;
  }

  return token;
}

function statsFromGuests(guests) {
  return {
    total: guests.length,
    confirmed: guests.filter((guest) => guest.rsvpStatus === 'confirmed').length,
    declined: guests.filter((guest) => guest.rsvpStatus === 'declined').length,
    pending: guests.filter((guest) => guest.rsvpStatus === 'pending').length,
    checkedIn: guests.filter((guest) => guest.checkInStatus === 'checked_in').length,
  };
}

function sanitizeGuestPayload(payload, { partial = false } = {}) {
  const next = {};
  const textFields = ['firstName', 'lastName', 'email', 'phone', 'group', 'tableNumber', 'plusOneName', 'notes'];

  for (const field of textFields) {
    if (payload[field] !== undefined) {
      next[field] = typeof payload[field] === 'string' ? payload[field].trim() : '';
    }
  }

  if (payload.plusOne !== undefined) {
    next.plusOne = Boolean(payload.plusOne);
  }

  if (payload.rsvpStatus !== undefined) {
    next.rsvpStatus = ['pending', 'confirmed', 'declined'].includes(payload.rsvpStatus)
      ? payload.rsvpStatus
      : 'pending';
  }

  if (payload.checkInStatus !== undefined) {
    next.checkInStatus = ['not_arrived', 'checked_in'].includes(payload.checkInStatus)
      ? payload.checkInStatus
      : 'not_arrived';
  }

  if (payload.checkInTime !== undefined) {
    next.checkInTime = payload.checkInTime || undefined;
  }

  if (!partial) {
    next.firstName = next.firstName || '';
    next.lastName = next.lastName || '';
    next.email = next.email || '';
    next.phone = next.phone || '';
    next.group = next.group || 'Autre';
    next.tableNumber = next.tableNumber || undefined;
    next.plusOne = next.plusOne ?? false;
    next.plusOneName = next.plusOne ? next.plusOneName || undefined : undefined;
    next.rsvpStatus = next.rsvpStatus || 'pending';
    next.notes = next.notes || undefined;
  } else if (next.plusOne === false) {
    next.plusOneName = undefined;
  }

  return next;
}

function normalizeComparableText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function createGuest(payload) {
  const guest = sanitizeGuestPayload(payload);
  if (!guest.firstName || !guest.lastName) {
    return null;
  }

  return {
    ...guest,
    id: randomUUID(),
    qrCode: randomUUID(),
    createdAt: new Date().toISOString(),
    checkInStatus: 'not_arrived',
  };
}

function isDuplicateGuest(candidate, existingGuest) {
  const candidateFirstName = normalizeComparableText(candidate.firstName);
  const candidateLastName = normalizeComparableText(candidate.lastName);
  const candidateEmail = normalizeComparableText(candidate.email);
  const candidatePhone = normalizePhone(candidate.phone);

  const existingFirstName = normalizeComparableText(existingGuest.firstName);
  const existingLastName = normalizeComparableText(existingGuest.lastName);
  const existingEmail = normalizeComparableText(existingGuest.email);
  const existingPhone = normalizePhone(existingGuest.phone);

  const sameIdentity = candidateFirstName === existingFirstName && candidateLastName === existingLastName;
  const sameEmail = candidateEmail && existingEmail && candidateEmail === existingEmail;
  const samePhone = candidatePhone && existingPhone && candidatePhone === existingPhone;

  return sameIdentity || sameEmail || samePhone;
}

function formatDuplicateReason(candidate, existingGuest) {
  const candidateEmail = normalizeComparableText(candidate.email);
  const candidatePhone = normalizePhone(candidate.phone);
  const existingEmail = normalizeComparableText(existingGuest.email);
  const existingPhone = normalizePhone(existingGuest.phone);

  if (candidateEmail && existingEmail && candidateEmail === existingEmail) {
    return `Duplicate guest: email already used by ${existingGuest.firstName} ${existingGuest.lastName}`;
  }

  if (candidatePhone && existingPhone && candidatePhone === existingPhone) {
    return `Duplicate guest: phone already used by ${existingGuest.firstName} ${existingGuest.lastName}`;
  }

  return `Duplicate guest: ${existingGuest.firstName} ${existingGuest.lastName} already exists`;
}

async function findDuplicateGuest(candidate, { excludeGuestId } = {}) {
  const guests = await listGuests();

  return guests.find((guest) => {
    if (excludeGuestId && guest.id === excludeGuestId) {
      return false;
    }

    return isDuplicateGuest(candidate, guest);
  }) || null;
}

function hasDuplicateInBatch(candidate, batch) {
  return batch.find((guest) => isDuplicateGuest(candidate, guest)) || null;
}

async function importGuestsFromRows(rows) {
  const guests = [];
  const skipped = [];

  for (const [index, row] of rows.entries()) {
    const guest = createGuest(row);
    if (!guest) {
      skipped.push({
        row: index + 2,
        reason: 'firstName and lastName are required',
      });
      continue;
    }

    const duplicateInBatch = hasDuplicateInBatch(guest, guests);
    if (duplicateInBatch) {
      skipped.push({
        row: index + 2,
        reason: formatDuplicateReason(guest, duplicateInBatch),
      });
      continue;
    }

    const duplicateInDatabase = await findDuplicateGuest(guest);
    if (duplicateInDatabase) {
      skipped.push({
        row: index + 2,
        reason: formatDuplicateReason(guest, duplicateInDatabase),
      });
      continue;
    }

    guests.push(guest);
  }

  return { guests, skipped };
}

function normalizeGuestDocument(document) {
  if (!document) {
    return null;
  }

  const { _id, ...guest } = document;
  return guest;
}

async function listGuests() {
  const guests = await guestsCollection.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  return guests;
}

async function findGuestById(id) {
  const guest = await guestsCollection.findOne({ id }, { projection: { _id: 0 } });
  return normalizeGuestDocument(guest);
}

async function findGuestByIdentifier(identifier) {
  const guest = await guestsCollection.findOne(
    { $or: [{ id: identifier }, { qrCode: identifier }] },
    { projection: { _id: 0 } },
  );
  return normalizeGuestDocument(guest);
}

async function updateGuest(guestId, patch) {
  await guestsCollection.updateOne({ id: guestId }, { $set: patch });
  return findGuestById(guestId);
}

const server = createServer(async (req, res) => {
  const origin = getOrigin(req);
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      Vary: 'Origin',
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      try {
        await mongoClient.db().command({ ping: 1 });
        const guestCount = await guestsCollection.countDocuments();
        sendJson(res, 200, {
          ok: true,
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          database: { status: 'connected', guests: guestCount },
          sessions: { active: sessions.size },
        }, origin);
      } catch (dbError) {
        sendJson(res, 503, {
          ok: false,
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          database: { status: 'unreachable', error: dbError.message },
          sessions: { active: sessions.size },
        }, origin);
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await parseBody(req);
      if (body.password !== adminPassword) {
        sendJson(res, 401, { error: 'Invalid credentials' }, origin);
        return;
      }

      const token = randomUUID();
      sessions.set(token, { createdAt: Date.now() });
      sendJson(res, 200, { token }, origin);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const token = getToken(req);
      sendJson(res, token && sessions.has(token) ? 200 : 401, { authenticated: Boolean(token && sessions.has(token)) }, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = getToken(req);
      if (token) {
        sessions.delete(token);
      }
      sendJson(res, 200, { success: true }, origin);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/guests') {
      if (!requireAuth(req, res, origin)) return;
      const guests = await listGuests();
      sendJson(res, 200, { guests, stats: statsFromGuests(guests) }, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/guests') {
      if (!requireAuth(req, res, origin)) return;

      const body = await parseBody(req);
      const guest = createGuest(body);

      if (!guest) {
        sendJson(res, 400, { error: 'firstName and lastName are required' }, origin);
        return;
      }

      const duplicateGuest = await findDuplicateGuest(guest);
      if (duplicateGuest) {
        sendJson(res, 409, { error: formatDuplicateReason(guest, duplicateGuest) }, origin);
        return;
      }

      await guestsCollection.insertOne(guest);
      sendJson(res, 201, { guest }, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/guests/import') {
      if (!requireAuth(req, res, origin)) return;

      const body = await parseBody(req);
      const rows = Array.isArray(body.guests) ? body.guests : [];

      if (rows.length === 0) {
        sendJson(res, 400, { error: 'guests must be a non-empty array' }, origin);
        return;
      }

      const { guests, skipped } = await importGuestsFromRows(rows);

      if (guests.length > 0) {
        await guestsCollection.insertMany(guests, { ordered: false });
      }

      sendJson(res, 201, {
        success: true,
        imported: guests.length,
        skipped,
      }, origin);
      return;
    }

    const guestMatch = url.pathname.match(/^\/api\/guests\/([^/]+)$/);
    if (guestMatch) {
      if (!requireAuth(req, res, origin)) return;

      const guestId = decodeURIComponent(guestMatch[1]);
      const guest = await findGuestById(guestId);

      if (!guest) {
        sendJson(res, 404, { error: 'Guest not found' }, origin);
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 200, { guest }, origin);
        return;
      }

      if (req.method === 'PATCH') {
        const body = await parseBody(req);
        const patch = sanitizeGuestPayload(body, { partial: true });
        const nextPatch = {
          ...guest,
          ...patch,
          tableNumber: patch.tableNumber === '' ? undefined : patch.tableNumber ?? guest.tableNumber,
          plusOneName: patch.plusOne === false ? undefined : patch.plusOneName ?? guest.plusOneName,
          notes: patch.notes === '' ? undefined : patch.notes ?? guest.notes,
        };

        const duplicateGuest = await findDuplicateGuest(nextPatch, { excludeGuestId: guestId });
        if (duplicateGuest) {
          sendJson(res, 409, { error: formatDuplicateReason(nextPatch, duplicateGuest) }, origin);
          return;
        }

        const updatedGuest = await updateGuest(guestId, nextPatch);
        sendJson(res, 200, { guest: updatedGuest }, origin);
        return;
      }

      if (req.method === 'DELETE') {
        await guestsCollection.deleteOne({ id: guestId });
        sendJson(res, 200, { success: true }, origin);
        return;
      }
    }

    const publicGuestMatch = url.pathname.match(/^\/api\/public\/guests\/([^/]+)$/);
    if (req.method === 'GET' && publicGuestMatch) {
      const identifier = decodeURIComponent(publicGuestMatch[1]);
      const guest = await findGuestByIdentifier(identifier);

      if (!guest) {
        sendJson(res, 404, { error: 'Guest not found' }, origin);
        return;
      }

      sendJson(res, 200, { guest }, origin);
      return;
    }

    const publicCheckInMatch = url.pathname.match(/^\/api\/public\/guests\/([^/]+)\/check-in$/);
    if (req.method === 'POST' && publicCheckInMatch) {
      const identifier = decodeURIComponent(publicCheckInMatch[1]);
      const guest = await findGuestByIdentifier(identifier);

      if (!guest) {
        sendJson(res, 404, { success: false, message: 'QR code invalide. Invite non trouve.' }, origin);
        return;
      }

      if (guest.rsvpStatus === 'declined') {
        sendJson(res, 409, { success: false, guest, message: `${guest.firstName} ${guest.lastName} a decline l'invitation.` }, origin);
        return;
      }

      if (guest.checkInStatus === 'checked_in') {
        sendJson(res, 409, { success: false, guest, message: `${guest.firstName} ${guest.lastName} est deja enregistre(e).` }, origin);
        return;
      }

      const updatedGuest = await updateGuest(guest.id, {
        checkInStatus: 'checked_in',
        checkInTime: guest.checkInTime || new Date().toISOString(),
      });

      sendJson(res, 200, { success: true, guest: updatedGuest, message: `Bienvenue ${guest.firstName} ${guest.lastName} !` }, origin);
      return;
    }

    sendJson(res, 404, { error: 'Not found' }, origin);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal server error' }, origin);
  }
});

initDatabase()
  .then(() => {
    server.listen(port, () => {
      console.log(`Wedding backend listening on http://localhost:${port}`);
      console.log('MongoDB connection established');
    });
  })
  .catch((error) => {
    console.error('Failed to start backend:', error);
    process.exit(1);
  });
