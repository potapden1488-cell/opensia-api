// server-ultimate.mjs - ПОЛНОСТЬЮ РАБОЧАЯ ВЕРСИЯ ДЛЯ ВНЕШНЕГО ДОСТУПА
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';

// ========== КОНФИГУРАЦИЯ ==========
const CONFIG = {
    port: 3000,
    host: '0.0.0.0',  // ВАЖНО: слушаем все интерфейсы
    apiKey: process.env.OPENROUTER_API_KEY || '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',
    siteUrl: process.env.SITE_URL || 'http://localhost:8000'
};

// ========== ХРАНИЛИЩЕ ДЛЯ ЗАЩИТЫ ==========
const store = { requests: new Map(), blocked: new Map() };

// ========== ФУНКЦИИ ЗАЩИТЫ ==========
function isBlocked(ip) { 
    return store.blocked.has(ip) && Date.now() < store.blocked.get(ip); 
}

function checkRateLimit(ip) {
    const now = Date.now();
    const requestData = store.requests.get(ip) || { count: 0, timestamp: now };
    
    if (now - requestData.timestamp > 60000) {
        requestData.count = 0;
        requestData.timestamp = now;
    }
    requestData.count++;
    store.requests.set(ip, requestData);
    
    if (requestData.count > 60) {
        store.blocked.set(ip, now + 300000);
        return false;
    }
    return true;
}

// ========== СОЗДАНИЕ СЕРВЕРА ==========
const server = createServer((req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
               req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
    
    // CORS - разрешаем всем (для внешнего доступа)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // Защита от DDoS
    if (isBlocked(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
    }
    
    if (!checkRateLimit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate Limit Exceeded' }));
        return;
    }
    
    const referer = CONFIG.siteUrl;
    
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        
        // Health check
        if (url.pathname === '/api/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'ok', 
                message: 'openSIA API работает',
                timestamp: new Date().toISOString(),
                external: true
            }));
            return;
        }
        
        // Чат API
        if (url.pathname === '/api/chat' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const requestData = JSON.parse(body);
                    
                    if (!requestData.messages || !Array.isArray(requestData.messages)) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid request format' }));
                        return;
                    }
                    
                    console.log(`\n📡 [${new Date().toLocaleTimeString()}] Запрос от ${ip}`);
                    const lastMsg = requestData.messages[requestData.messages.length - 1]?.content;
                    console.log(`📝 Сообщение: ${lastMsg?.slice(0, 50)}...`);
                    
                    const options = {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${CONFIG.apiKey}`,
                            'Content-Type': 'application/json',
                            'HTTP-Referer': referer,
                            'X-Title': 'openSIA'
                        }
                    };
                    
                    const startTime = Date.now();
                    
                    const proxyReq = httpsRequest('https://openrouter.ai/api/v1/chat/completions', options, (proxyRes) => {
                        let data = '';
                        proxyRes.on('data', chunk => data += chunk);
                        proxyRes.on('end', () => {
                            const duration = Date.now() - startTime;
                            console.log(`✅ Ответ за ${duration}ms`);
                            
                            try {
                                res.writeHead(200, { 
                                    'Content-Type': 'application/json',
                                    'X-Response-Time': duration
                                });
                                res.end(data);
                            } catch (e) {
                                console.error('❌ Ошибка:', e);
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: 'Invalid response from API' }));
                            }
                        });
                    });
                    
                    proxyReq.on('error', (error) => {
                        console.error('❌ Ошибка прокси:', error);
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Proxy error: ' + error.message }));
                    });
                    
                    proxyReq.write(JSON.stringify({
                        model: requestData.model || 'deepseek/deepseek-chat',
                        messages: requestData.messages,
                        temperature: requestData.temperature || 1.2,
                        max_tokens: requestData.max_tokens || 2048,
                        stream: false
                    }));
                    proxyReq.end();
                    
                } catch (error) {
                    console.error('❌ Ошибка:', error);
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }
        
        // Статистика
        if (url.pathname === '/api/stats' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                requests: store.requests.size,
                blocked: store.blocked.size,
                timestamp: new Date().toISOString()
            }));
            return;
        }
        
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
        
    } catch (error) {
        console.error('❌ Ошибка сервера:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
});

// ========== ЗАПУСК ==========
server.listen(CONFIG.port, CONFIG.host, () => {
    const getLocalIP = () => {
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return 'localhost';
    };
    
    const localIP = getLocalIP();
    
    console.log('\n' + '='.repeat(60));
    console.log('\x1b[36m%s\x1b[0m', '╔══════════════════════════════════════════════════════════╗');
    console.log('\x1b[35m%s\x1b[0m', '║              🚀 openSIA ПРОКСИ-СЕРВЕР                    ║');
    console.log('\x1b[36m%s\x1b[0m', '╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('\x1b[32m%s\x1b[0m', '✅ Сервер успешно запущен!');
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', '📡 ДОСТУПНЫЕ АДРЕСА:');
    console.log(`   🌐 Локально:  \x1b[36mhttp://localhost:${CONFIG.port}\x1b[0m`);
    console.log(`   📱 Сеть:      \x1b[36mhttp://${localIP}:${CONFIG.port}\x1b[0m`);
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', '🔗 ЭНДПОИНТЫ:');
    console.log(`   ✅ Health:    \x1b[36mhttp://localhost:${CONFIG.port}/api/health\x1b[0m`);
    console.log(`   💬 Chat:      \x1b[36mhttp://localhost:${CONFIG.port}/api/chat\x1b[0m (POST)`);
    console.log(`   📊 Stats:     \x1b[36mhttp://localhost:${CONFIG.port}/api/stats\x1b[0m`);
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', '🔒 БЕЗОПАСНОСТЬ:');
    console.log(`   🔑 API Key:   \x1b[36m${CONFIG.apiKey.slice(0, 10)}...${CONFIG.apiKey.slice(-5)}\x1b[0m`);
    console.log(`   🛡️ Rate Limit: 60 запросов/минуту`);
    console.log(`   🚫 Блокировка: после 60 запросов на 5 минут`);
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', '💡 ДЛЯ ВНЕШНЕГО ДОСТУПА:');
    console.log(`   1. Запусти Cloudflare Tunnel:`);
    console.log(`      \x1b[36mcloudflared tunnel --url http://localhost:8000\x1b[0m`);
    console.log(`   2. Или используй DuckDNS + проброс портов`);
    console.log('');
    console.log('\x1b[32m%s\x1b[0m', '🎉 Готов к работе! Жду сообщений...');
    console.log('='.repeat(60) + '\n');
});

// ========== ОБРАБОТКА ОСТАНОВКИ ==========
process.on('SIGINT', () => {
    console.log('\n\x1b[33m%s\x1b[0m', '🛑 Остановка сервера...');
    console.log('\x1b[36m%s\x1b[0m', '📊 Статистика:');
    console.log(`   📡 Всего запросов: ${store.requests.size}`);
    console.log(`   🚫 Заблокировано IP: ${store.blocked.size}`);
    console.log('\x1b[32m%s\x1b[0m', '👋 Сервер остановлен');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('\x1b[31m%s\x1b[0m', '❌ Ошибка:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('\x1b[31m%s\x1b[0m', '❌ Reject:', reason);
});