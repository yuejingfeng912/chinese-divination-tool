#!/usr/bin/env node
/**
 * 算上一卦 · 本地 AI 中转服务
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   纯前端 HTML 里调用大模型 API，API Key 必须写进 JS，等于公开 —— 任何人
 *   查看网页源码就能拿走你的 key 并盗刷额度。这个问题在纯前端架构下无解。
 *
 * 本服务的做法：
 *   浏览器  →  http://127.0.0.1:8787/chat  →  本服务  →  大模型 API
 *   key 只存在于本服务的进程内存（从 .env 读取），永远不会下发给浏览器，
 *   也不会进入 Git 仓库（.env 已在 .gitignore 中）。
 *
 * 启动：
 *   node server/proxy.js          （Windows 也可双击 启动代理.bat）
 *   默认监听 127.0.0.1:8787，只允许本机访问，不对外暴露。
 *
 * 依赖：Node 18+ 内置 fetch，零第三方依赖。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 配置加载
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    // 去掉可能的引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const ENV = loadEnv();

const PORT = parseInt(process.env.PORT || ENV.PORT || '8787', 10);
const HOST = process.env.HOST || ENV.HOST || '127.0.0.1'; // 只绑本机
const API_KEY = process.env.LLM_API_KEY || ENV.LLM_API_KEY || '';
const API_BASE = (process.env.LLM_BASE_URL || ENV.LLM_BASE_URL || 'https://api.deepseek.com/v1/chat/completions').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || ENV.LLM_MODEL || 'deepseek-chat';
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || ENV.LLM_TIMEOUT_MS || '60000', 10);

console.log('┌─────────────────────────────────────────────┐');
console.log('│  算上一卦 · 本地 AI 中转服务                │');
console.log('└─────────────────────────────────────────────┘');
console.log(`  监听地址   : http://${HOST}:${PORT}`);
console.log(`  模型       : ${MODEL}`);
console.log(`  接口       : ${API_BASE}`);
console.log(`  API Key    : ${API_KEY ? '已从 .env 读取（不会下发给浏览器）' : '未配置 — 请在 .env 中设置 LLM_API_KEY'}`);
if (!API_KEY) {
  console.log('');
  console.log('  ⚠ 未配置 Key，/chat 将返回 503。');
  console.log('    复制 .env.example 为 .env，填入你的 Key 后重启本服务。');
}
console.log('');

// ---------------------------------------------------------------- 工具
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // 健康检查：前端用它探测代理是否在线（只返回布尔，不泄露任何密钥信息）
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'suan-shang-yi-gua-proxy',
      hasKey: !!API_KEY,
      model: MODEL,
      base: API_BASE.replace(/\/v1\/.*$/, ''), // 只显示厂商域名，不含路径细节
    });
  }

  if (req.method === 'POST' && req.url === '/chat') {
    if (!API_KEY) {
      return json(res, 503, {
        error: '未配置 API Key。请在项目根目录复制 .env.example 为 .env，填入 LLM_API_KEY 后重启代理服务。',
        code: 'NO_API_KEY',
      });
    }

    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw);
    } catch (e) {
      return json(res, 400, { error: '请求体解析失败：' + e.message });
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!messages || !messages.length) {
      return json(res, 400, { error: '缺少 messages 字段' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(API_BASE, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: payload.model || MODEL,
          messages,
          temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.85,
          max_tokens: payload.max_tokens || 2000,
          stream: false,
        }),
      });

      const text = await upstream.text();
      if (!upstream.ok) {
        // 上游错误原样回传状态码与信息（不含 key）
        let detail = text.slice(0, 600);
        try { detail = JSON.parse(text).error?.message || detail; } catch (e) { /* 保持原样 */ }
        return json(res, upstream.status, { error: `上游接口返回 ${upstream.status}：${detail}` });
      }

      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { return json(res, 502, { error: '上游返回内容无法解析为 JSON' }); }

      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return json(res, 502, { error: '上游返回中未找到正文内容' });
      }

      return json(res, 200, {
        ok: true,
        content,
        model: parsed?.model || MODEL,
        usage: parsed?.usage || null,
      });
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? `请求超时（${TIMEOUT_MS}ms）`
        : `调用失败：${e.message}`;
      return json(res, 502, { error: msg });
    } finally {
      clearTimeout(timer);
    }
  }

  return json(res, 404, { error: 'Not Found' });
});

server.listen(PORT, HOST, () => {
  console.log('  ✓ 服务已启动，按 Ctrl+C 停止。');
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`  ✗ 端口 ${PORT} 已被占用。请关闭占用程序，或在 .env 中改 PORT 后重启。`);
  } else {
    console.error('  ✗ 启动失败：' + e.message);
  }
  process.exit(1);
});
