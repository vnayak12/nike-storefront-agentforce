const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

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
// Key: defer 200 until upstream confirms, so browser gets real 503 on failures
app.get('/api/agent/sse', (req, res) => {
    const accessToken = req.query.token;
    if (!accessToken) {
        return res.status(400).json({ error: 'Missing token' });
    }

    let closed = false;
    let keepalive = null;
    let headersSent = false;

    function cleanup(sseReq) {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        if (sseReq) sseReq.destroy();
        try { res.end(); } catch {}
    }

    const options = {
        hostname: SCRT2_DOMAIN,
        path: '/eventrouter/v1/sse',
        method: 'GET',
        timeout: 30000,  // 30s connect timeout, then we keep alive
        headers: {
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${accessToken}`,
            'X-Org-Id': ORG_ID
        }
    };

    let buffer = '';
    const sseReq = https.request(options, (sseRes) => {
        // If upstream returns non-200, pass through the exact status
        if (sseRes.statusCode !== 200) {
            console.error('SSE upstream status:', sseRes.statusCode);
            if (!headersSent) {
                res.status(sseRes.statusCode).json({ error: `upstream_${sseRes.statusCode}` });
                headersSent = true;
            }
            cleanup(sseReq);
            return;
        }

        // Upstream confirmed 200 — now start SSE to browser
        if (!headersSent) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.write(':ok\n\n');
            headersSent = true;

            // Heroku has a 55s idle timeout — send keepalive pings every 20s
            keepalive = setInterval(() => {
                if (closed) return;
                try { res.write(':ping\n\n'); } catch {}
            }, 20000);
        }

        // Disable timeout now that we're streaming
        sseReq.setTimeout(0);

        sseRes.on('data', (chunk) => {
            if (closed) return;
            buffer += chunk.toString();

            // SSE events are delimited by double-newline. Process complete events.
            const events = buffer.split('\n\n');
            buffer = events.pop() || ''; // Keep incomplete event in buffer

            for (const event of events) {
                if (!event.trim()) continue;
                const lines = event.split('\n');
                for (const line of lines) {
                    if (line.startsWith('event:')) continue; // Strip event type
                    if (line.startsWith('id:')) continue;    // Strip event IDs
                    if (line.trim()) {
                        try { res.write(line + '\n'); } catch {}
                    }
                }
                try { res.write('\n'); } catch {} // Event delimiter
            }
        });
        sseRes.on('end', () => cleanup(sseReq));
        sseRes.on('error', (err) => {
            console.error('SSE upstream error:', err.message);
            cleanup(sseReq);
        });
    });

    sseReq.on('error', (err) => {
        console.error('SSE request error:', err.message);
        if (!headersSent) {
            res.status(502).json({ error: 'SSE upstream connection failed' });
            headersSent = true;
        }
        cleanup(sseReq);
    });

    sseReq.on('timeout', () => {
        console.error('SSE connect timeout');
        if (!headersSent) {
            res.status(504).json({ error: 'SSE upstream timeout' });
            headersSent = true;
        }
        cleanup(sseReq);
    });

    sseReq.end();

    req.on('close', () => cleanup(sseReq));
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

app.listen(PORT, () => {
    console.log(`Nike Storefront running on port ${PORT}`);
});
