const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory debug log ring buffer
const debugLog = [];
const MAX_DEBUG = 100;
function dlog(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    debugLog.push(entry);
    if (debugLog.length > MAX_DEBUG) debugLog.shift();
    console.log(msg);
}

// Prevent uncaught exceptions from crashing the server
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err.message || err);
});

// SCRT2 Configuration
const SCRT2_DOMAIN = 'trailsignup-d7fd90d7f30b8a.my.salesforce-scrt.com';
const ORG_ID = '00Dbm00000jtzs9';
const ES_DEVELOPER_NAME = 'Nike_Headless_API';

// Security headers with CSP allowing Salesforce MIAW widget
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://*.salesforce.com",
                "https://*.force.com",
                "https://*.salesforce-scrt.com",
                "https://*.my.site.com",
                "https://*.my.salesforce.com",
                "https://*.my.salesforce-setup.com"
            ],
            scriptSrcAttr: [
                "'unsafe-inline'"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://*.salesforce.com",
                "https://*.my.site.com"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://*.salesforce.com"
            ],
            imgSrc: [
                "'self'",
                "data:",
                "https:",
                "blob:"
            ],
            connectSrc: [
                "'self'",
                "https://*.salesforce.com",
                "https://*.force.com",
                "https://*.salesforce-scrt.com",
                "https://*.my.site.com",
                "https://*.my.salesforce.com",
                "wss://*.salesforce-scrt.com"
            ],
            frameSrc: [
                "'self'",
                "https://*.salesforce.com",
                "https://*.force.com",
                "https://*.my.site.com"
            ],
            workerSrc: ["'self'", "blob:"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false
}));

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== SCRT2 PROXY ROUTES =====

// Helper: make HTTPS request to SCRT2
function scrt2Request(method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: SCRT2_DOMAIN,
            path: urlPath,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// 1. Get unauthenticated access token
app.post('/api/agent/token', async (req, res) => {
    try {
        const result = await scrt2Request('POST',
            '/iamessage/api/v2/authorization/unauthenticated/access-token',
            {},
            {
                orgId: ORG_ID,
                esDeveloperName: ES_DEVELOPER_NAME,
                capabilitiesVersion: '1',
                platform: 'Web'
            }
        );
        res.status(result.statusCode).json(JSON.parse(result.body));
    } catch (err) {
        console.error('Token error:', err.message);
        res.status(500).json({ error: 'Failed to get token' });
    }
});

// 2. Create conversation
app.post('/api/agent/conversation', async (req, res) => {
    try {
        const { accessToken, conversationId } = req.body;
        const result = await scrt2Request('POST',
            '/iamessage/api/v2/conversation',
            {
                'Authorization': `Bearer ${accessToken}`,
                'X-Org-Id': ORG_ID
            },
            {
                conversationId: conversationId,
                esDeveloperName: ES_DEVELOPER_NAME,
                routingAttributes: {
                    _firstName: 'Nike',
                    _lastName: 'Shopper'
                }
            }
        );
        res.status(result.statusCode).send(result.body);
    } catch (err) {
        console.error('Conversation error:', err.message);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

// 3. Send message
app.post('/api/agent/message', async (req, res) => {
    try {
        const { accessToken, conversationId, text, messageId, isNewSession } = req.body;
        const result = await scrt2Request('POST',
            `/iamessage/api/v2/conversation/${conversationId}/message`,
            {
                'Authorization': `Bearer ${accessToken}`,
                'X-Org-Id': ORG_ID
            },
            {
                message: {
                    id: messageId,
                    messageType: 'StaticContentMessage',
                    staticContent: {
                        formatType: 'Text',
                        text: text
                    }
                },
                esDeveloperName: ES_DEVELOPER_NAME,
                isNewMessagingSession: isNewSession || false,
                routingAttributes: {},
                language: 'en'
            }
        );
        res.status(result.statusCode).send(result.body);
    } catch (err) {
        console.error('Message error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// 4. SSE proxy — streams events from SCRT2 to the browser
// Sends 200 immediately so Heroku router doesn't time out, then proxies SCRT2 events
app.get('/api/agent/sse', (req, res) => {
    try {
    // Accept token from header (preferred) or query param (fallback)
    const accessToken = req.headers['x-agent-token'] || req.query.token;
    if (!accessToken) {
        return res.status(400).json({ error: 'Missing token' });
    }
    dlog('SSE request received, token length: ' + accessToken.length);

    // Send SSE headers IMMEDIATELY — don't wait for upstream
    // This prevents Heroku router from timing out
    // Use res.set + res.status + res.flushHeaders to work with helmet middleware
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.status(200);
    res.flushHeaders();
    res.write(':ok\n\n');

    let closed = false;
    const keepalive = setInterval(() => {
        if (closed) return;
        try { res.write(':ping\n\n'); } catch {}
    }, 20000);

    function cleanup(sseReq) {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        if (sseReq) sseReq.destroy();
        try { res.end(); } catch {}
    }

    const options = {
        hostname: SCRT2_DOMAIN,
        path: '/eventrouter/v1/sse',
        method: 'GET',
        timeout: 30000,
        headers: {
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${accessToken}`,
            'X-Org-Id': ORG_ID
        }
    };

    let buffer = '';
    let retryCount = 0;
    const maxRetries = 5;

    function connectUpstream() {
        if (closed) return;
        buffer = '';
        dlog('connectUpstream called, retryCount=' + retryCount);

        const sseReq = https.request(options, (sseRes) => {
            dlog('SSE upstream response status: ' + sseRes.statusCode);
            if (sseRes.statusCode !== 200) {
                let body = '';
                sseRes.on('data', c => body += c);
                sseRes.on('end', () => {
                    dlog('SSE upstream error body: ' + body.substring(0, 200));
                });
                try { res.write(`data:{"error":"upstream_${sseRes.statusCode}"}\n\n`); } catch {}
                retryCount++;
                if (retryCount <= maxRetries && !closed) {
                    const delay = Math.min(2000 * retryCount, 10000);
                    dlog(`SSE upstream retry ${retryCount}/${maxRetries} in ${delay}ms`);
                    setTimeout(connectUpstream, delay);
                } else if (!closed) {
                    try { res.write(`data:{"error":"max_retries"}\n\n`); } catch {}
                    cleanup(null);
                }
                return;
            }

            dlog('SSE upstream connected OK');
            retryCount = 0;
            sseReq.setTimeout(0);

            sseRes.on('data', (chunk) => {
                if (closed) return;
                const chunkStr = chunk.toString();
                buffer += chunkStr;
                dlog('SSE upstream chunk: ' + chunkStr.length + ' bytes');

                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const event of events) {
                    if (!event.trim()) continue;
                    const lines = event.split('\n');
                    let forwarded = false;
                    for (const line of lines) {
                        if (line.startsWith('event:')) continue;
                        if (line.startsWith('id:')) continue;
                        if (line.trim()) {
                            try { res.write(line + '\n'); forwarded = true; } catch (e) {
                                dlog('res.write failed: ' + e.message);
                            }
                        }
                    }
                    if (forwarded) {
                        try { res.write('\n'); } catch {}
                        dlog('SSE forwarded event to browser');
                    }
                }
            });
            sseRes.on('end', () => {
                dlog('SSE upstream ended');
                if (!closed) {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        setTimeout(connectUpstream, 2000);
                    } else {
                        cleanup(null);
                    }
                }
            });
            sseRes.on('error', (err) => {
                dlog('SSE upstream error: ' + err.message);
                if (!closed) {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        setTimeout(connectUpstream, 2000);
                    } else {
                        cleanup(null);
                    }
                }
            });
        });

        sseReq.on('error', (err) => {
            dlog('SSE request error: ' + err.message);
            if (!closed) {
                retryCount++;
                if (retryCount <= maxRetries) {
                    setTimeout(connectUpstream, 2000);
                } else {
                    try { res.write(`data:{"error":"connection_failed"}\n\n`); } catch {}
                    cleanup(null);
                }
            }
        });

        sseReq.on('timeout', () => {
            dlog('SSE connect timeout');
            sseReq.destroy();
            if (!closed) {
                retryCount++;
                if (retryCount <= maxRetries) {
                    setTimeout(connectUpstream, 2000);
                } else {
                    try { res.write(`data:{"error":"timeout"}\n\n`); } catch {}
                    cleanup(null);
                }
            }
        });

        sseReq.end();
        req.on('close', () => { dlog('Browser SSE closed'); closed = true; sseReq.destroy(); cleanup(null); });
    }

    connectUpstream();
    } catch (err) {
        dlog('SSE handler crash: ' + err.message);
        try { res.status(500).json({ error: 'internal_error' }); } catch {}
    }
});

// 5. Close conversation
app.delete('/api/agent/conversation/:conversationId', async (req, res) => {
    try {
        const { conversationId } = req.params;
        const accessToken = req.headers.authorization?.replace('Bearer ', '');
        const result = await scrt2Request('DELETE',
            `/iamessage/api/v2/conversation/${conversationId}?esDeveloperName=${ES_DEVELOPER_NAME}`,
            { 'Authorization': `Bearer ${accessToken}` },
            null
        );
        res.status(result.statusCode).send(result.body || '{}');
    } catch (err) {
        console.error('Close error:', err.message);
        res.status(500).json({ error: 'Failed to close conversation' });
    }
});

// ===== MAIN ROUTES =====

// Main storefront route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Product detail page
app.get('/product/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check for Heroku
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Version check
app.get('/api/version', (req, res) => {
    res.json({ version: 'v6-debug-sse', ts: Date.now() });
});

// Debug log endpoint
app.get('/api/debug', (req, res) => {
    res.json({ logs: debugLog, count: debugLog.length });
});

app.listen(PORT, () => {
    console.log(`Nike Storefront running on port ${PORT}`);
});
