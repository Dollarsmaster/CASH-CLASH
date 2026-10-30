let pubClient = null;
let subClient = null;
let ready = false;
let lastError = null;

// Socket.IO's Redis adapter distributes room broadcasts and server-side events
// between instances. It does not replace the authoritative game-state store.
export async function initializeSocketAdapter(io) {
  if (!process.env.REDIS_URL) return { enabled: false, ready: false };
  try {
    const [{ createClient }, { createAdapter }] = await Promise.all([
      import('redis'),
      import('@socket.io/redis-adapter'),
    ]);
    pubClient = createClient({ url: process.env.REDIS_URL });
    subClient = pubClient.duplicate();
    for (const client of [pubClient, subClient]) {
      client.on('error', error => {
        lastError = error.message;
        ready = false;
        console.error('Socket.IO Redis adapter error:', error.message);
      });
      client.on('ready', () => {
        ready = Boolean(pubClient?.isReady && subClient?.isReady);
        if (ready) lastError = null;
      });
      client.on('end', () => { ready = false; });
    }
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    ready = true;
    lastError = null;
    return { enabled: true, ready: true };
  } catch (error) {
    lastError = error.message;
    ready = false;
    console.error('Socket.IO Redis adapter initialization failed:', error.message);
    return { enabled: true, ready: false, error: error.message };
  }
}

export function socketAdapterStatus() {
  return { enabled: Boolean(process.env.REDIS_URL), ready, error: lastError };
}

export async function closeSocketAdapter() {
  await Promise.all([pubClient, subClient].filter(client => client?.isOpen).map(client => client.quit()));
  ready = false;
}
