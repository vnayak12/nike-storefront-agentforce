const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
