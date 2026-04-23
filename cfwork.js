/**
 * =================================================================================
 * 项目: aqua-2api (Cloudflare Worker 单文件版)
 * 版本: 4.9.1 (代号: Chimera Synthesis - Free Tier Optimized Edition)
 * 作者: 首席AI执行官 (Principal AI Executive Officer) & Gemini
 * 协议: 奇美拉协议 · 终极版
 * * [v4.9.1 终极进化]
 * 1. [免费用户专享过滤] 在前端自动屏蔽 15 款 Premium 高级收费模型，列表更加清爽纯净。
 * 2. [移动端空间释放] 重构参数面板为超紧凑 Input Group 布局，彻底解决输入区占用痛点。
 * 3. [媒体下载引擎] 为 AI 绘图与视频引入纯前端 Blob 原生下载协议，一键保存至本地。
 * 4. [降级安全保护] 将底层兜底模型修改为免费标准的 gpt-5.4-mini，杜绝偷跑越权。
 * 5. [100% CF 原生反代] 图床上传、流式请求、媒体下载全部走 Worker 同源策略，国内免翻。
 * =================================================================================
 */

// ---[第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "aqua-2api",
  PROJECT_VERSION: "4.9.1",

  // 安全配置 (主密钥)
  API_MASTER_KEY: "1", 
  BUILTIN_KEY: "你的key",

  // 上游服务配置
  UPSTREAM_URL: "https://api.aquadevs.com",
  
  // 默认模型配置
  DEFAULT_CHAT_MODEL: "grok-4.2",
  FALLBACK_CHAT_MODEL: "gpt-5.4-mini", // 自动降级模型 (已修改为免费模型)
  DEFAULT_IMAGE_MODEL: "flux-2",
  DEFAULT_VIDEO_MODEL: "grok-video",

  // 轮询与重试配置
  POLLING_INTERVAL: 3000,
  POLLING_TIMEOUT: 120000,
  MAX_RETRIES: 3,
};

// ---[补充部分: 静态脚本拦截 (PWA & Markdown Worker)] ---
const SW_CODE = `
const CACHE_NAME = 'aqua-v4.9-cache';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('fetch', e => {
    if (e.request.url.includes('cdn.jsdelivr.net') || e.request.url.includes('unpkg.com')) {
        e.respondWith(
            caches.match(e.request).then(response => {
                return response || fetch(e.request).then(res => {
                    const resClone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
                    return res;
                });
            })
        );
    }
});
`;

const MD_WORKER_CODE = `
importScripts('https://cdn.jsdelivr.net/npm/marked/marked.min.js');
importScripts('https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js');
importScripts('https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js');
importScripts('https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js');
importScripts('https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-json.min.js');
importScripts('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js');

function renderMath(text) {
    return text.replace(/\\$\\$([\\s\\S]+?)\\$\\$/g, (m, p1) => {
        try { return katex.renderToString(p1, {displayMode: true}); } catch(e) { return m; }
    }).replace(/\\$([^\\n\\$]+?)\\$/g, (m, p1) => {
        try { return katex.renderToString(p1, {displayMode: false}); } catch(e) { return m; }
    });
}

marked.setOptions({
    highlight: function(code, lang) {
        try {
            if (Prism.languages[lang]) return Prism.highlight(code, Prism.languages[lang], lang);
            return Prism.highlight(code, Prism.languages.javascript, 'javascript');
        } catch (err) {
            return code; // 终极降级保护，防止语法树解析崩溃阻断主线程
        }
    }
});

self.onmessage = function(e) {
    const { id, text } = e.data;
    try {
        let processedText = renderMath(text);
        self.postMessage({ id, html: marked.parse(processedText) });
    } catch (err) {
        self.postMessage({ id, html: text }); // 若 Marked 引擎崩溃直接原样返回
    }
};
`;

// ---[第二部分: 核心工具类 (Logger & Fetcher)] ---

class Logger {
  constructor(request, env) {
    this.traceId = request.headers.get('X-Request-ID') || crypto.randomUUID();
    this.startTime = Date.now();
    this.method = request.method;
    this.url = request.url;
    this.env = env;
    this.logs = [];
  }
  info(step, data = null) { this.logs.push({ level: 'INFO', time: new Date().toISOString(), step, data }); }
  warn(step, data = null) { this.logs.push({ level: 'WARN', time: new Date().toISOString(), step, data }); }
  error(step, error) { this.logs.push({ level: 'ERROR', time: new Date().toISOString(), step, message: error.message || String(error), stack: error.stack }); }
  flush(status) {
    const duration = Date.now() - this.startTime;
    console.log(JSON.stringify({ trace_id: this.traceId, method: this.method, url: this.url, status: status, duration: `${duration}ms`, details: this.logs }, null, 2));
  }
}

async function fetchUpstream(url, options, logger) {
  let attempt = 0;
  let delay = 1000;
  let lastResponseText = "";
  let lastStatusCode = 0;

  while (attempt <= CONFIG.MAX_RETRIES) {
    try {
      const res = await fetch(url, options);
      lastStatusCode = res.status;
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      lastResponseText = await res.text();
      logger.warn(`Upstream Error ${res.status}: ${lastResponseText}, retrying... (${attempt + 1}/${CONFIG.MAX_RETRIES})`, { url });
    } catch (err) {
      lastResponseText = err.message;
      lastStatusCode = 0;
      logger.error(`Fetch Exception, retrying... (${attempt + 1}/${CONFIG.MAX_RETRIES})`, err);
    }
    attempt++;
    if (attempt > CONFIG.MAX_RETRIES) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    delay *= 2; 
  }
  
  // Auto-Fallback Logic for Chat API if totally failed
  if (url.includes('/v1/chat/completions') && options.body) {
      try {
          let bodyObj = JSON.parse(options.body);
          if (bodyObj.model !== CONFIG.FALLBACK_CHAT_MODEL) {
              logger.info(`Auto-Fallback triggered to ${CONFIG.FALLBACK_CHAT_MODEL}`);
              bodyObj.model = CONFIG.FALLBACK_CHAT_MODEL;
              options.body = JSON.stringify(bodyObj);
              const fallbackRes = await fetch(url, options);
              if (fallbackRes.ok) return fallbackRes;
          }
      } catch(e) { /* Ignore parsing errors on fallback */ }
  }

  throw new Error(`上游接口(HTTPS)返回状态码 ${lastStatusCode}。重试 ${CONFIG.MAX_RETRIES} 次均失败。最后一次报错: ${lastResponseText.substring(0, 500)}`);
}

// ---[独立功能: 双引擎图床转 URL] ---
async function processBase64ToUrl(base64Str) {
    if (!base64Str || typeof base64Str !== 'string' || !base64Str.startsWith('data:image/')) return base64Str;
    const match = base64Str.match(/^data:(image\/\w+);base64,(.*)$/);
    if (!match) return base64Str;
    const pureBase64 = match[2];

    try {
        const paramsA = new URLSearchParams();
        paramsA.append('key', '6d207e02198a847aa98d0a2a901485a5'); 
        paramsA.append('action', 'upload');
        paramsA.append('source', pureBase64);
        paramsA.append('format', 'json');
        const resA = await fetch('https://freeimage.host/api/1/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
            body: paramsA
        });
        const dataA = await resA.json();
        if (resA.ok && dataA?.image?.url) return dataA.image.url;
    } catch (e) { console.warn("Freeimage.host failed...", e); }

    try {
        const paramsB = new URLSearchParams();
        paramsB.append('key', '319ec8eb48cc1348a60f9e9de0dd6c2d'); 
        paramsB.append('image', pureBase64);
        const resB = await fetch('https://api.imgbb.com/1/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
            body: paramsB
        });
        const dataB = await resB.json();
        if (resB.ok && dataB?.data?.url) return dataB.data.url;
        throw new Error(`ImgBB rejected: ${dataB.error?.message || JSON.stringify(dataB)}`);
    } catch (e) { throw new Error(`双图床全部溃败: ${e.message}`); }
}

async function handleUploadRequest(request, logger) {
    if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405, 'method_not_allowed');
    try {
        const body = await request.json();
        const url = await processBase64ToUrl(body.image);
        if (url.startsWith('http')) {
            return new Response(JSON.stringify({ url }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
        } else {
            throw new Error("未能获取公网URL");
        }
    } catch (err) {
        return createErrorResponse(err.message, 500, 'upload_error');
    }
}

// ---[第三部分: Worker 入口] ---

export default {
  async fetch(request, env, ctx) {
    const logger = new Logger(request, env);
    logger.info('Request Received');

    try {
      if (request.headers.get("Upgrade") === "websocket") {
        logger.info("WebSocket connection established. Proxying...");
        const targetUrl = new URL(request.url);
        const upstreamParsed = new URL(CONFIG.UPSTREAM_URL);
        targetUrl.hostname = upstreamParsed.hostname;
        targetUrl.protocol = upstreamParsed.protocol === 'https:' ? 'wss:' : 'ws:';
        targetUrl.port = upstreamParsed.port;
        
        const authResult = authenticate(request, env);
        const wsRequest = new Request(targetUrl.toString(), request);
        wsRequest.headers.set('Authorization', `Bearer ${authResult.authKey}`);
        wsRequest.headers.set('Host', upstreamParsed.hostname);
        
        return fetch(wsRequest);
      }

      if (request.method === 'OPTIONS') {
        const res = handleCorsPreflight();
        logger.flush(res.status);
        return res;
      }

      const url = new URL(request.url);
      let response;

      if (url.pathname === '/') response = await handleUI(request, env);
      else if (url.pathname === '/sw.js') response = new Response(SW_CODE, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
      else if (url.pathname === '/md-worker.js') response = new Response(MD_WORKER_CODE, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
      else if (url.pathname === '/health') response = await handleHealthCheck(logger);
      else if (url.pathname.startsWith('/generation/') || url.pathname.startsWith('/v1/video/files/')) response = await handleMediaProxy(request, ctx, logger);
      else if (url.pathname.startsWith('/v1/')) {
        const authResult = authenticate(request, env);
        if (authResult.error) response = createErrorResponse(authResult.error, authResult.status, 'auth_error');
        else response = await router(request, url, authResult.authKey, logger, ctx);
      } 
      else response = createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');

      const finalResponse = new Response(response.body, response);
      finalResponse.headers.set('X-Worker-Trace-ID', logger.traceId);
      logger.flush(finalResponse.status);
      return finalResponse;

    } catch (err) {
      logger.error('Unhandled Exception', err);
      return createErrorResponse(`内部服务器错误: ${err.message}`, 500, 'internal_error');
    }
  }
};

function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  let authKey = env.BUILTIN_KEY || CONFIG.BUILTIN_KEY; 
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const masterKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    if (token !== masterKey) authKey = token;
  }
  return { authKey };
}

async function router(request, url, authKey, logger, ctx) {
  switch (url.pathname) {
    case '/v1/upload': return await handleUploadRequest(request, logger);
    case '/v1/models': return await handleModelsRequest(request, authKey, ctx, logger);
    case '/v1/chat/completions': return await handleChatCompletions(request, authKey, logger);
    case '/v1/images/generations': return await handleImageGenerations(request, authKey, logger, ctx);
    case '/v1/video/generations': return await handleVideoGenerations(request, authKey, logger, ctx);
    case '/v1/extract':
    case '/v1/search': return await handleToolsRequest(request, authKey, url.pathname, logger);
    default:
      if (url.pathname.startsWith('/v1/tasks/')) {
        const taskId = url.pathname.split('/').pop();
        return await handleTaskPoll(request, taskId, authKey, logger);
      }
      return createErrorResponse(`不支持的路径: ${url.pathname}`, 404, 'not_found');
  }
}

// ---[第四部分: 业务逻辑处理器] ---

async function handleHealthCheck(logger) {
  const res = await fetchUpstream(`${CONFIG.UPSTREAM_URL}/health`, { cf: { http3: 'on' } }, logger);
  return new Response(JSON.stringify(await res.json()), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

async function handleModelsRequest(request, authKey, ctx, logger) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/v1/models', 'https://aqua-2api.cache').toString());
  let response = await cache.match(cacheKey);
  const userAgent = request.headers.get('User-Agent') || 'Aqua-Worker/4.9.1';

  const fetchAndUpdate = async () => {
    try {
      const upstreamRes = await fetchUpstream(`${CONFIG.UPSTREAM_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${authKey}`, 'User-Agent': userAgent }, cf: { http3: 'on' }
      }, logger);
      if (upstreamRes.ok) {
        await cache.put(cacheKey, new Response(upstreamRes.body, { headers: corsHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=86400' }) }));
      }
    } catch (e) { logger.error('SWR Update Error', e); }
  };

  if (!response) {
    await fetchAndUpdate();
    response = await cache.match(cacheKey);
    if (!response) throw new Error("获取模型列表失败");
  } else ctx.waitUntil(fetchAndUpdate()); 
  return response;
}

async function handleChatCompletions(request, authKey, logger) {
  const body = await request.json();
  const userAgent = request.headers.get('User-Agent') || 'Aqua-Worker/4.9.1';
  
  if (body.messages) {
      for (let msg of body.messages) {
          if (Array.isArray(msg.content)) {
              for (let part of msg.content) {
                  if (part.type === 'image_url' && part.image_url?.url.startsWith('data:image/')) {
                      part.image_url.url = await processBase64ToUrl(part.image_url.url);
                  }
              }
          }
      }
  }

  const upstreamResponse = await fetchUpstream(`${CONFIG.UPSTREAM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authKey}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(body),
    cf: { http3: 'on' }
  }, logger);

  if (!upstreamResponse.ok) throw new Error(`Chat Upstream Error: ${await upstreamResponse.text()}`);
  const newHeaders = new Headers(upstreamResponse.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: newHeaders });
}

async function handleImageGenerations(request, authKey, logger, ctx) {
  const body = await request.json();
  const isStream = body.stream === true; 
  const userAgent = request.headers.get('User-Agent') || 'Aqua-Worker/4.9.1';
  
  const size = body.size || "1:1";
  let ratio = "square";
  if (size === "9:16" || size === "1024x1792") ratio = "portrait";
  if (size === "16:9" || size === "1792x1024") ratio = "landscape";

  const payload = { model: body.model || CONFIG.DEFAULT_IMAGE_MODEL, prompt: body.prompt, ratio: ratio };
  if (body.images && body.images.length > 0) {
      payload.images = await Promise.all(body.images.map(img => processBase64ToUrl(img)));
      payload.image = payload.images[0]; 
  } else if (body.image) {
      payload.image = await processBase64ToUrl(body.image);
  }

  const res = await fetchUpstream(`${CONFIG.UPSTREAM_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authKey}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(payload),
    cf: { http3: 'on' }
  }, logger);

  if (!res.ok) throw new Error(`Image Upstream Error: ${await res.text()}`);
  const data = await res.json();

  if (data.url && data.url.includes('/tasks/') && isStream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    ctx.waitUntil((async () => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "processing", message: "图像任务排队中..." })}\n\n`));
        const startTime = Date.now();
        let isCompleted = false;

        while (Date.now() - startTime < CONFIG.POLLING_TIMEOUT) {
          await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
          const pollRes = await fetchUpstream(data.url, { headers: { 'Authorization': `Bearer ${authKey}`, 'User-Agent': userAgent }, cf: { http3: 'on' } }, logger);
          const pollData = await pollRes.json();
          
          if (pollData.status === 'completed') {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "completed", url: proxyMediaUrl(pollData.result.url, request.url) })}\n\n`));
            isCompleted = true; break;
          } else if (pollData.status === 'failed') throw new Error("图像生成任务失败");
          else await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "processing", message: "拼命绘制中..." })}\n\n`));
        }
        if (!isCompleted) throw new Error("轮询超时");
      } catch (err) {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`));
      } finally { await writer.close(); }
    })());
    return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }) });
  }

  return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data:[{ url: proxyMediaUrl(data.url, request.url) }] }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

async function handleVideoGenerations(request, authKey, logger, ctx) {
  const body = await request.json();
  const isStream = body.stream === true;
  const payload = { model: body.model || CONFIG.DEFAULT_VIDEO_MODEL, prompt: body.prompt };
  const userAgent = request.headers.get('User-Agent') || 'Aqua-Worker/4.9.1';

  const res = await fetchUpstream(`${CONFIG.UPSTREAM_URL}/v1/video/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authKey}`, 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(payload),
    cf: { http3: 'on' }
  }, logger);

  if (!res.ok) throw new Error(`Video Upstream Error: ${await res.text()}`);
  const data = await res.json();

  if (data.url && data.url.includes('/tasks/') && isStream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      ctx.waitUntil((async () => {
          try {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "processing", progress: 0, message: "视频分配计算节点中..." })}\n\n`));
              const startTime = Date.now();
              let isCompleted = false;

              while (Date.now() - startTime < CONFIG.POLLING_TIMEOUT) {
                  await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
                  const pollRes = await fetchUpstream(data.url, { headers: { 'Authorization': `Bearer ${authKey}`, 'User-Agent': userAgent } }, logger);
                  const pollData = await pollRes.json();
                  
                  if (pollData.status === 'completed') {
                      await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "completed", url: proxyMediaUrl(pollData.result?.url || pollData.url, request.url) })}\n\n`));
                      isCompleted = true; break;
                  } else if (pollData.status === 'failed') {
                      throw new Error("视频生成渲染失败");
                  } else {
                      const pct = pollData.progress !== undefined ? parseInt(pollData.progress) : (pollData.result?.progress || 0);
                      await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "processing", progress: pct, message: '帧渲染进行中...' })}\n\n`));
                  }
              }
              if (!isCompleted) throw new Error("轮询渲染超时");
          } catch (err) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`));
          } finally { await writer.close(); }
      })());
      return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }) });
  }
  return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data:[{ url: proxyMediaUrl(data.url, request.url) }] }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

async function handleTaskPoll(request, taskId, authKey, logger) {
  const res = await fetchUpstream(`${CONFIG.UPSTREAM_URL}/v1/images/tasks/${taskId}`, {
    headers: { 'Authorization': `Bearer ${authKey}`, 'User-Agent': request.headers.get('User-Agent') || 'Aqua/4.9.1' }, cf: { http3: 'on' }
  }, logger);
  if (!res.ok) throw new Error(`Poll Error: ${await res.text()}`);
  return new Response(JSON.stringify(await res.json()), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

async function handleToolsRequest(request, authKey, path, logger) {
  const res = await fetchUpstream(`${CONFIG.UPSTREAM_URL}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authKey}`, 'Content-Type': 'application/json', 'User-Agent': request.headers.get('User-Agent') || 'Aqua/4.9.1' },
    body: JSON.stringify(await request.json()), cf: { http3: 'on' }
  }, logger);
  const newHeaders = new Headers(res.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers: newHeaders });
}

async function handleMediaProxy(request, ctx, logger) {
  const url = new URL(request.url);
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  let response = await cache.match(cacheKey);
  if (!response) {
    const headers = { 'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0' };
    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;
    response = await fetch(`${CONFIG.UPSTREAM_URL}${url.pathname}`, { headers, cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (response.ok || response.status === 206) {
      response = new Response(response.body, response);
      response.headers.set('Cache-Control', 'public, max-age=86400');
      response.headers.set('Access-Control-Allow-Origin', '*');
      if (response.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
  }
  return response;
}

function proxyMediaUrl(originalUrl, requestUrl) {
  if (!originalUrl) return originalUrl;
  const workerOrigin = new URL(requestUrl).origin;
  if (originalUrl.startsWith(CONFIG.UPSTREAM_URL)) return originalUrl.replace(CONFIG.UPSTREAM_URL, workerOrigin);
  return originalUrl;
}
function createErrorResponse(message, status, code) { return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), { status, headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }) }); }
function handleCorsPreflight() { return new Response(null, { status: 204, headers: corsHeaders() }); }
function corsHeaders(headers = {}) { return { ...headers, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range', 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length' }; }

// ---[第六部分: Cockpit Pro Max WebUI (Neo-Glassmorphism + Framer Dynamics)] ---
function handleUI(request, env) {
  const origin = new URL(request.url).origin;
  const masterKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>${CONFIG.PROJECT_NAME} - Ultimate Cockpit</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    
    <style>
      /* --- 环境感知色彩空间 (Oklch Transition) --- */
      :root {
        --theme-hue: 200; /* 默认蓝色调 */
        --theme-sat: 80%;
        --bg-gradient: linear-gradient(135deg, hsl(var(--theme-hue), 80%, 95%) 0%, #f8fafc 100%);
        --glass-bg: rgba(255, 255, 255, 0.55);
        --glass-border: rgba(255, 255, 255, 0.6);
        --glass-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.07);
        --glass-blur: blur(24px) saturate(180%);
        --text-color: #0f172a; --text-secondary: #475569;
        --primary-color: hsl(var(--theme-hue), var(--theme-sat), 45%); 
        --primary-glow: hsla(var(--theme-hue), var(--theme-sat), 45%, 0.4);
        --primary-hover: hsl(var(--theme-hue), var(--theme-sat), 35%); 
        --input-bg: rgba(255, 255, 255, 0.7);
        --error-color: #ef4444; --success-color: #10b981; --warning-color: #f59e0b;
        --msg-user-bg: hsla(var(--theme-hue), var(--theme-sat), 45%, 0.15); 
        --msg-user-color: hsl(var(--theme-hue), var(--theme-sat), 25%);
        --msg-ai-bg: rgba(255, 255, 255, 0.85);
        --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        --ui-transition: all 0.6s cubic-bezier(0.25, 1, 0.5, 1);
      }
      
      @media (prefers-color-scheme: dark) {
        :root {
          --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e293b 100%, #020617 150%);
          --glass-bg: rgba(15, 23, 42, 0.65);
          --glass-border: rgba(255, 255, 255, 0.08);
          --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
          --text-color: #f1f5f9; --text-secondary: #94a3b8;
          --primary-color: hsl(var(--theme-hue), var(--theme-sat), 60%); 
          --primary-glow: hsla(var(--theme-hue), var(--theme-sat), 60%, 0.3);
          --primary-hover: hsl(var(--theme-hue), var(--theme-sat), 50%); 
          --input-bg: rgba(15, 23, 42, 0.7);
          --msg-user-bg: hsla(var(--theme-hue), var(--theme-sat), 60%, 0.15); 
          --msg-user-color: #e0f2fe;
          --msg-ai-bg: rgba(30, 41, 59, 0.85);
        }
      }
      
      * { box-sizing: border-box; transition: color 0.4s, background-color 0.4s, border-color 0.4s; }
      body { 
        font-family: var(--font-family); margin: 0; 
        background: var(--bg-gradient); color: var(--text-color); 
        font-size: 14px; display: flex; height: 100vh; height: 100dvh; overflow: hidden;
        overscroll-behavior-y: none; /* 防止移动端下拉刷新引起页面跳动 */
        transition: var(--ui-transition);
      }
      
      /* 布局与毛玻璃外壳 */
      .layout { display: flex; width: 100%; height: 100%; position: relative; z-index: 2; }
      
      /* 移动端深色遮罩层 */
      .sidebar-mask {
        display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
        z-index: 40; opacity: 0; transition: opacity 0.3s ease;
      }
      .sidebar-mask.open { display: block; opacity: 1; }

      /* 背景炫光装饰 */
      .bg-orb { position: absolute; border-radius: 50%; filter: blur(80px); z-index: 1; opacity: 0.5; pointer-events: none; transition: var(--ui-transition); }
      .bg-orb-1 { width: 400px; height: 400px; background: var(--primary-color); top: -100px; left: -100px; }
      .bg-orb-2 { width: 300px; height: 300px; background: var(--success-color); bottom: -50px; right: -50px; opacity: 0.3;}

      /* 移动端菜单切换 */
      .menu-toggle { display: none; position: absolute; top: 15px; left: 15px; z-index: 50; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 8px; padding: 8px; cursor: pointer; backdrop-filter: var(--glass-blur);}

      .sidebar { 
        width: 340px; flex-shrink: 0; 
        background: var(--glass-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
        border-right: 1px solid var(--glass-border); box-shadow: var(--glass-shadow);
        display: flex; flex-direction: column; z-index: 50;
        transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1);
      }
      .sidebar-header { padding: 24px 20px; border-bottom: 1px solid var(--glass-border); }
      .sidebar-content { flex: 1; overflow-y: auto; padding: 20px; }
      .main-content { flex: 1; display: flex; flex-direction: column; background: transparent; position: relative; z-index: 5; width: 100%; }
      
      h1 { margin: 0; font-size: 20px; color: var(--primary-color); display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: -0.5px;}
      .badge { font-size: 11px; background: var(--primary-color); color: #fff; padding: 3px 8px; border-radius: 12px; font-weight: bold; box-shadow: 0 0 10px var(--primary-glow); }
      
      .box { 
        background: var(--input-bg); padding: 15px; border-radius: 12px; 
        border: 1px solid var(--glass-border); margin-bottom: 15px;
      }
      
      /* 重置原生 select 样式 */
      select {
        appearance: none; -webkit-appearance: none;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 10px center; background-size: 14px; padding-right: 30px;
      }
      @media (prefers-color-scheme: dark) {
        select { background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E"); }
      }

      /* 超紧凑参数组件 (Input Group) - 核心排版重构 */
      .param-compact {
          display: flex; align-items: center; background: rgba(0,0,0,0.03);
          border: 1px solid var(--glass-border); border-radius: 10px;
          padding-left: 12px;
      }
      @media (prefers-color-scheme: dark) { .param-compact { background: rgba(255,255,255,0.03); } }
      .param-compact .label { margin: 0; padding-right: 8px; border-right: 1px solid var(--glass-border); white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;}
      .param-compact select { border: none; background: transparent; margin: 0; padding: 0 10px; flex: 1; min-height: 40px; color: var(--text-color); font-family: inherit;}
      .param-compact select:focus { outline: none; box-shadow: none; background: transparent;}
      
      .param-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
      .param-row > .param-compact { flex: 1; min-width: 140px; }

      input[type="password"] { 
        width: 100%; background: rgba(0,0,0,0.03); border: 1px solid var(--glass-border); 
        color: var(--text-color); padding: 12px; border-radius: 10px; font-family: inherit; margin-bottom:0;
      }
      
      textarea { 
        width: 100%; background: rgba(0,0,0,0.03); border: 1px solid var(--glass-border); 
        color: var(--text-color); padding: 12px; border-radius: 10px; font-family: inherit; 
        transition: all 0.3s ease; backdrop-filter: blur(4px);
        resize: none; min-height: 44px; margin: 0;
      }
      @media (prefers-color-scheme: dark) { textarea, input[type="password"] { background: rgba(255,255,255,0.03); } }
      textarea:focus, input[type="password"]:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 3px var(--primary-glow); background: var(--glass-bg); }
      
      button { 
        padding: 12px; background: var(--primary-color); border: none; 
        border-radius: 10px; font-weight: bold; cursor: pointer; color: #fff; 
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); 
        display: flex; justify-content: center; align-items: center; gap: 8px;
        box-shadow: 0 4px 15px var(--primary-glow); min-height: 44px;
      }
      button:hover { background: var(--primary-hover); transform: translateY(-2px); box-shadow: 0 6px 20px var(--primary-glow); }
      button:active { transform: scale(0.97); }
      
      .terminal-header { 
        display: flex; background: var(--glass-bg); backdrop-filter: var(--glass-blur); 
        border-bottom: 1px solid var(--glass-border); overflow-x: auto; white-space: nowrap; padding: 0 10px;
        -webkit-overflow-scrolling: touch; scrollbar-width: none;
      }
      .terminal-header::-webkit-scrollbar { display: none; }
      .tab { padding: 16px 20px; cursor: pointer; color: var(--text-secondary); font-weight: 600; border-bottom: 3px solid transparent; transition: all 0.3s; }
      .tab:hover { color: var(--text-color); }
      .tab.active { color: var(--primary-color); border-bottom-color: var(--primary-color); }
      
      .chat-box { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 24px; scroll-behavior: smooth; }
      
      .msg-wrapper { display: flex; flex-direction: column; gap: 4px; width: 100%; animation: msgPop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
      .msg-wrapper.user { align-items: flex-end; }
      .msg-wrapper.ai { align-items: flex-start; }

      .msg { max-width: 85%; padding: 14px 18px; border-radius: 16px; line-height: 1.6; position: relative; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
      @keyframes msgPop { 0% { opacity: 0; transform: translateY(15px) scale(0.98); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
      
      .msg.user { background: var(--msg-user-bg); color: var(--msg-user-color); border-bottom-right-radius: 4px; border: 1px solid var(--glass-border);}
      .msg.ai { background: var(--msg-ai-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border: 1px solid var(--glass-border); border-bottom-left-radius: 4px; width: 100%; overflow-x: hidden; }
      .msg.error { border-color: var(--error-color); background: rgba(239, 68, 68, 0.1); color: var(--error-color); }
      
      .msg-actions { display: flex; gap: 8px; opacity: 0; transition: opacity 0.3s; font-size: 12px; margin-top: -2px; padding: 0 10px; flex-wrap: wrap; }
      .msg-wrapper:hover .msg-actions { opacity: 1; }
      .action-btn { background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 6px; padding: 6px 10px; cursor: pointer; color: var(--text-secondary); backdrop-filter: blur(4px); box-shadow: none; width: auto; min-height: 28px; font-weight: normal;}
      .action-btn:hover { color: var(--primary-color); border-color: var(--primary-color); transform: none; background: var(--glass-bg);}

      .msg.ai p { margin-top: 0; }
      .msg.ai pre { background: rgba(0,0,0,0.8); padding: 16px; border-radius: 12px; overflow-x: auto; border: 1px solid rgba(255,255,255,0.1); margin: 12px 0; }
      .msg.ai code { font-family: var(--font-mono); font-size: 13px; color: #e2e8f0; }
      .msg.ai img, .msg.ai video { max-width: 100%; border-radius: 12px; margin-top: 12px; border: 1px solid var(--glass-border); cursor: zoom-in; box-shadow: var(--glass-shadow); transition: transform 0.3s;}
      
      .skeleton-media { width: 100%; height: 200px; background: linear-gradient(90deg, rgba(255,255,255,0.1) 25%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.1) 75%); background-size: 400% 100%; animation: skeleton-loading 1.5s infinite ease-in-out; border-radius: 12px; border: 1px dashed var(--glass-border); display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-weight: bold; }
      @media (prefers-color-scheme: dark) { .skeleton-media { background: linear-gradient(90deg, rgba(0,0,0,0.2) 25%, rgba(0,0,0,0.4) 50%, rgba(0,0,0,0.2) 75%); } }
      @keyframes skeleton-loading { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

      /* 极简上传区 */
      .upload-zone { border: 2px dashed var(--glass-border); border-radius: 10px; padding: 12px; text-align: center; cursor: pointer; transition: all 0.3s; margin-bottom: 8px; background: rgba(0,0,0,0.02); display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 50px;}
      .upload-zone.dragover { border-color: var(--primary-color); background: var(--primary-glow); transform: scale(1.02); }
      .image-queue { display: flex; gap: 8px; overflow-x: auto; padding-top: 5px; width: 100%; justify-content: center;}
      .queue-item { position: relative; width: 44px; height: 44px; flex-shrink: 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--glass-border); }
      .queue-item img { width: 100%; height: 100%; object-fit: cover; }
      
      .token-monitor { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; padding: 0 4px; }
      .progress-container { width: 100%; background: rgba(0,0,0,0.1); height: 6px; border-radius: 3px; overflow: hidden; border: 1px solid var(--glass-border); }
      .progress-bar { height: 100%; background: var(--primary-color); box-shadow: 0 0 10px var(--primary-glow); transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      .progress-bar.warning { background: var(--warning-color); box-shadow: 0 0 10px var(--warning-color); }
      .progress-bar.danger { background: var(--error-color); box-shadow: 0 0 10px var(--error-color); }
      
      .input-area { padding: 15px 20px; background: var(--glass-bg); backdrop-filter: var(--glass-blur); border-top: 1px solid var(--glass-border); box-shadow: 0 -10px 40px rgba(0,0,0,0.05);}
      
      .panel { display: none; animation: fadeIn 0.3s ease; }
      .panel.active { display: block; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

      /* ======================================================== */
      /* 移动端终极空间释放优化 (Space Optimization)              */
      /* ======================================================== */
      @media (max-width: 768px) {
          .menu-toggle { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0; top: 8px; left: 8px; font-size: 18px; }
          .sidebar { position: fixed; transform: translateX(-100%); height: 100%; box-shadow: 20px 0 50px rgba(0,0,0,0.5); width: 300px; left: 0;}
          .sidebar.open { transform: translateX(0); }
          .terminal-header { padding-left: 60px; }
          .msg { max-width: 95%; font-size: 15px; }
          .msg-actions { opacity: 1; }
          
          /* 核心：极其紧凑的底部安全区适配，释放 50% 占用 */
          .input-area { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); }
          
          /* 核心：字号严格 16px 防止 iOS 聚焦放大 */
          select, textarea { font-size: 16px !important; }
          
          .param-compact { min-height: 38px; }
          .param-compact select { padding: 0 8px; min-height: 38px;}
          .param-row { gap: 6px; margin-bottom: 6px;}
          
          #prompt { height: 44px; min-height: 44px; }
          #btn-send { width: 75px; font-size: 14px; padding: 0; }
      }
    </style>
</head>
<body>
    <div class="bg-orb bg-orb-1"></div>
    <div class="bg-orb bg-orb-2"></div>
    
    <div class="layout">
        <div class="sidebar-mask" onclick="toggleMobileMenu()"></div>
        
        <aside class="sidebar">
            <div class="sidebar-header">
                <h1>🌊 Cockpit <span class="badge">PRO MAX</span></h1>
                <div style="margin-top: 8px; font-size: 11px; color: var(--text-secondary); display:flex; justify-content:space-between;">
                    <span>全链路代理原生在线</span>
                    <span id="auto-fallback-indicator" style="display:none; color:var(--warning-color);">降级保护触发</span>
                </div>
            </div>
            
            <div class="sidebar-content">
                <div class="box">
                    <span class="label" style="font-size: 12px; margin-bottom: 8px;">当前会话 Token 探针</span>
                    <div class="token-monitor">
                        <span>记忆体用量</span><span id="token-count">0 / 180K</span>
                    </div>
                    <div class="progress-container" style="height: 4px;">
                        <div id="token-bar" class="progress-bar" style="width: 0%;"></div>
                    </div>
                    <p style="font-size:10px; color:var(--text-secondary); margin-top:8px; margin-bottom:0;">* 若接近 180K，系统将触发滑动窗口压缩重组历史。</p>
                </div>
                
                <div class="box">
                    <span class="label" style="font-size: 12px; margin-bottom: 8px;">API 密钥 (点击复制)</span>
                    <form autocomplete="off" onsubmit="return false;" style="margin:0; padding:0;">
                        <input type="password" id="api-key" value="${masterKey}" readonly onclick="copyText(this.value); this.type='text'; setTimeout(()=>this.type='password', 2000)">
                    </form>
                </div>

                <div class="history-panel box" style="background:transparent; border:none; padding:0; margin-top:20px;">
                    <span class="label" style="display:flex; justify-content:space-between; align-items:center; font-size: 12px; margin-bottom: 8px;">
                        <span>📜 历史记忆体</span>
                        <span style="cursor:pointer; color:var(--error-color);" onclick="clearHistory()">净化</span>
                    </span>
                    <button class="action-btn" style="width:100%; margin-bottom:10px; justify-content:center;" onclick="startNewSession()">+ 开启全新纪元分支</button>
                    <div id="history-list" style="max-height: 200px; overflow-y:auto;"></div>
                </div>
            </div>
        </aside>

        <main class="main-content">
            <button class="menu-toggle" onclick="toggleMobileMenu()">☰</button>
            
            <div class="terminal-header">
                <div class="tab active" data-target="chat">💬 超维对话</div>
                <div class="tab" data-target="image">🎨 绘图引擎</div>
                <div class="tab" data-target="video">🎬 视界生成</div>
                <div class="tab" data-target="tools">🛠️ 工具挂载</div>
            </div>

            <div class="chat-box" id="chat-box">
                <div style="text-align:center; color:var(--text-secondary); margin-top:10vh; animation: fadeIn 1s ease;" id="welcome-msg">
                    <div style="font-size:56px; margin-bottom:20px;">💠</div>
                    <h2 style="color:var(--text-color); font-weight:800; margin-bottom: 10px;">代理会话树已构建</h2>
                    <p style="max-width:400px; margin:0 auto; line-height:1.8;">全链路由 CF Worker 在海外为您转发，极致压缩排版。<br><span style="font-size:12px; color:var(--warning-color);">注: 建议在 CF 绑定自有域名，即可在国内完全免翻直连。</span></p>
                </div>
            </div>

            <div class="input-area" id="input-area">
                <div id="panel-chat" class="panel active">
                    <div class="param-row">
                        <div class="param-compact"><span class="label">模型选择</span><select id="chat-model" onchange="updateThemeAndSave()"><option>加载中...</option></select></div>
                    </div>
                </div>

                <div id="panel-image" class="panel">
                    <div class="param-row">
                        <div class="param-compact"><span class="label">模型选择</span><select id="image-model" onchange="updateThemeAndSave()"><option>加载中...</option></select></div>
                        <div class="param-compact"><span class="label">画幅比例</span><select id="image-ratio" onchange="updateThemeAndSave()"><option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option></select></div>
                    </div>
                    <div class="upload-zone" id="upload-zone">
                        <span style="color:var(--text-secondary); font-size: 11px;">点击/拖拽提供参考图 (可选)</span>
                        <div class="image-queue" id="image-queue"></div>
                    </div>
                </div>

                <div id="panel-video" class="panel">
                    <div class="param-row">
                        <div class="param-compact"><span class="label">模型选择</span><select id="video-model" onchange="updateThemeAndSave()"><option>加载中...</option></select></div>
                    </div>
                </div>

                <div id="panel-tools" class="panel">
                    <div class="param-row">
                        <div class="param-compact"><span class="label">工具套件</span><select id="tools-type" onchange="updateThemeAndSave()"><option value="extract">网页信息提取</option><option value="search">广域网检索</option></select></div>
                    </div>
                </div>

                <div style="display:flex; gap:10px; align-items: flex-end;">
                    <textarea id="prompt" style="flex:1;" placeholder="在此输入指令矩阵 (Enter 发送，Shift+Enter 换行)..."></textarea>
                    <button id="btn-send" style="width: 90px; font-size:15px; border-radius:10px; margin: 0;" onclick="submitUserPrompt()">发送 🚀</button>
                </div>
            </div>
        </main>
    </div>

    <script>
        const CFG = { ORIGIN: '${origin}', KEY: '${masterKey}', MAX_TOKEN: 180000 };
        let currentMode = 'chat'; 
        let abortController = null;
        let uploadedImages = []; 
        
        let currentSessionHistory = []; 
        let currentEstimatedTokens = 0;

        if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});

        const mdWorker = new Worker('/md-worker.js');
        const renderTasks = new Map();
        mdWorker.onmessage = (e) => {
            if (renderTasks.has(e.data.id)) { renderTasks.get(e.data.id)(e.data.html); renderTasks.delete(e.data.id); }
        };
        async function renderMarkdownAsync(text) {
            return new Promise(res => { const id = Math.random().toString(36); renderTasks.set(id, res); mdWorker.postMessage({ id, text }); });
        }
        
        window.toggleMobileMenu = function() {
            const sidebar = document.querySelector('.sidebar');
            const mask = document.querySelector('.sidebar-mask');
            sidebar.classList.toggle('open');
            if (sidebar.classList.contains('open')) {
                mask.style.display = 'block';
                void mask.offsetWidth; 
                mask.classList.add('open');
            } else {
                mask.classList.remove('open');
                setTimeout(() => mask.style.display = 'none', 300);
            }
        };

        function updateThemeAndSave() {
            savePreferences();
            const root = document.documentElement;
            const modelName = document.getElementById(currentMode + '-model')?.value?.toLowerCase() || '';
            
            if (modelName.includes('flux') || modelName.includes('mj') || modelName.includes('image')) {
                root.style.setProperty('--theme-hue', '270'); 
            } else if (modelName.includes('video')) {
                root.style.setProperty('--theme-hue', '340'); 
            } else if (modelName.includes('claude')) {
                root.style.setProperty('--theme-hue', '25'); 
            } else {
                root.style.setProperty('--theme-hue', '200'); 
            }
        }

        function calculateTokens(text) { return Math.ceil(text.length * 1.5); }

        function updateTokenUI() {
            let total = 0;
            currentSessionHistory.forEach(msg => {
                if (typeof msg.content === 'string') total += calculateTokens(msg.content);
                else total += calculateTokens(JSON.stringify(msg.content));
            });
            currentEstimatedTokens = total;
            
            const bar = document.getElementById('token-bar');
            const pct = Math.min((total / CFG.MAX_TOKEN) * 100, 100);
            document.getElementById('token-count').innerText = \`\${total.toLocaleString()} / 180K\`;
            bar.style.width = pct + '%';
            
            bar.className = 'progress-bar';
            if (pct > 90) bar.classList.add('danger');
            else if (pct > 75) bar.classList.add('warning');
            
            if (total > CFG.MAX_TOKEN) compressContextWindow();
        }

        function compressContextWindow() {
            if (currentSessionHistory.length <= 2) return;
            const keepCount = Math.floor(currentSessionHistory.length / 2);
            currentSessionHistory = [
                currentSessionHistory[0], 
                ...currentSessionHistory.slice(currentSessionHistory.length - keepCount)
            ];
            updateTokenUI();
            alert("⚠️ 触及 180K 记忆上限，已自动执行历史流形压缩保活。");
        }

        function startNewSession() {
            currentSessionHistory = [];
            document.getElementById('chat-box').innerHTML = '<div style="text-align:center; color:var(--text-secondary); margin-top:10vh;"><h2>✨ 全新纪元已开启</h2><p>记忆体已清空，尽情创造吧。</p></div>';
            updateTokenUI();
        }

        function branchSession(msgId) {
            const index = currentSessionHistory.findIndex(m => m.id === msgId);
            if (index !== -1) {
                currentSessionHistory = currentSessionHistory.slice(0, index + 1);
                reRenderChatBox();
                updateTokenUI();
            }
        }

        function deleteMessage(msgId) {
            currentSessionHistory = currentSessionHistory.filter(m => m.id !== msgId);
            reRenderChatBox();
            updateTokenUI();
        }

        function editMessage(msgId) {
            const msg = currentSessionHistory.find(m => m.id === msgId);
            if (msg && msg.role === 'user') {
                document.getElementById('prompt').value = typeof msg.content === 'string' ? msg.content : msg.content[0].text;
                branchSession(msgId); 
                deleteMessage(msgId); 
            }
        }

        function copyMessageText(msgId) {
            const msg = currentSessionHistory.find(m => m.id === msgId);
            if (msg) {
                const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                copyText(text);
                const btn = event.target;
                const originalText = btn.innerHTML;
                btn.innerHTML = '✅ 已复制';
                setTimeout(() => { btn.innerHTML = originalText; }, 2000);
            }
        }

        function regenerateMessage(msgId) {
            const index = currentSessionHistory.findIndex(m => m.id === msgId);
            if (index > 0) {
                currentSessionHistory = currentSessionHistory.slice(0, index);
                reRenderChatBox();
                updateTokenUI();
                triggerAIGeneration(); 
            }
        }

        // --- 原生 Blob 媒体极速下载引擎 ---
        window.downloadMedia = async function(url, type) {
            const btn = event.target;
            const originalText = btn.innerHTML;
            try {
                btn.innerHTML = '⏳ 下载中...';
                // 通过 Worker 的同源策略直接拉取文件流
                const res = await fetch(url);
                if (!res.ok) throw new Error('Fetch failed');
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = \`Aqua_\${type}_\${Date.now()}.\${type === 'video' ? 'mp4' : 'png'}\`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
                
                btn.innerHTML = '✅ 下载完成';
                setTimeout(() => { btn.innerHTML = originalText; }, 2000);
            } catch (err) {
                console.error("下载失败:", err);
                btn.innerHTML = '❌ 失败,已弹窗';
                setTimeout(() => { btn.innerHTML = originalText; }, 2000);
                window.open(url, '_blank'); // 降级为新标签页打开
            }
        };

        function reRenderChatBox() {
            const box = document.getElementById('chat-box');
            box.innerHTML = '';
            currentSessionHistory.forEach(msg => {
                const wrapper = document.createElement('div');
                wrapper.className = 'msg-wrapper ' + msg.role;
                
                const div = document.createElement('div');
                div.className = 'msg ' + msg.role;
                div.innerHTML = msg.html;
                
                const actions = document.createElement('div');
                actions.className = 'msg-actions';
                
                if(msg.role === 'user') {
                    actions.innerHTML += \`<button class="action-btn" onclick="editMessage('\${msg.id}')">✏️ 编辑重发</button>\`;
                    actions.innerHTML += \`<button class="action-btn" onclick="branchSession('\${msg.id}')">✂️ 分支截断</button>\`;
                    actions.innerHTML += \`<button class="action-btn" onclick="deleteMessage('\${msg.id}')">🗑️ 删除</button>\`;
                } else if(msg.role === 'ai') {
                    actions.innerHTML += \`<button class="action-btn" onclick="copyMessageText('\${msg.id}')">📋 复制答案</button>\`;
                    // 若含有媒体URL，直接注入纯净下载按钮
                    if (msg.mediaUrl) {
                        actions.innerHTML += \`<button class="action-btn" style="color:var(--primary-color); font-weight:bold;" onclick="downloadMedia('\${msg.mediaUrl}', '\${msg.mediaType}')">📥 极速下载</button>\`;
                    }
                    actions.innerHTML += \`<button class="action-btn" onclick="regenerateMessage('\${msg.id}')">🔄 重新生成</button>\`;
                    actions.innerHTML += \`<button class="action-btn" onclick="branchSession('\${msg.id}')">✂️ 分支截断</button>\`;
                    actions.innerHTML += \`<button class="action-btn" onclick="deleteMessage('\${msg.id}')">🗑️ 删除</button>\`;
                }

                wrapper.appendChild(div);
                wrapper.appendChild(actions);
                box.appendChild(wrapper);
            });
            box.scrollTop = box.scrollHeight;
        }

        function pushMessageToDOM(msgObj) {
            currentSessionHistory.push(msgObj);
            reRenderChatBox();
            updateTokenUI();
        }

        document.addEventListener('DOMContentLoaded', async () => {
            document.querySelectorAll('.tab').forEach(tab => {
                tab.onclick = () => {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                    tab.classList.add('active'); currentMode = tab.dataset.target;
                    document.getElementById('panel-' + currentMode).classList.add('active');
                    updateThemeAndSave();
                };
            });
            document.getElementById('prompt').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitUserPrompt(); } };
            setupImageUpload(); 
            await fetchModels(); 
            loadPreferences(); 
            updateThemeAndSave();
        });

        async function fetchModels() {
            try {
                const res = await fetch(CFG.ORIGIN + '/v1/models', { headers: { 'Authorization': 'Bearer ' + CFG.KEY } });
                if (!res.ok) throw new Error('Failed');
                const data = await res.json();
                
                // [免费用户专享过滤] 在前端自动屏蔽高级收费模型，只保留标准模型
                const premiumModels = new Set([
                    "haiku-4.5", "opus-4.5", "opus-4.6", "opus-4.7", "sonnet-4.5", "sonnet-4.6",
                    "gemini-2.5-pro", "gemini-3.1-pro", "glm-5.1", "gpt-5.1", "gpt-5.2", 
                    "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-spark", "gpt-5.4"
                ]);

                const c = data.data.filter(m => 
                    !m.id.match(/image|video|flux|midjourney|nanobanana|seedream|zimage|imagen/) &&
                    !premiumModels.has(m.id) // 执行拦截剔除
                );
                
                const i = data.data.filter(m => m.id.match(/image|flux|midjourney|nanobanana|seedream|zimage|imagen/));
                const v = data.data.filter(m => m.id.match(/video/));

                populateSelect('chat-model', c.length ? c :[{id:'gpt-5'}]);
                populateSelect('image-model', i.length ? i :[{id:'flux-2'}]);
                populateSelect('video-model', v.length ? v :[{id:'grok-video'}]);
            } catch (e) {
                populateSelect('chat-model', [{id:'gpt-5'}, {id:'gpt-4o'}]); 
                populateSelect('image-model', [{id:'flux-2'}]); 
                populateSelect('video-model', [{id:'grok-video'}]);
            }
        }
        function populateSelect(id, models) {
            const sel = document.getElementById(id); const currentVal = sel.value;
            sel.innerHTML = models.map(m => \`<option value="\${m.id}">\${m.id}</option>\`).join('');
            if(currentVal && models.find(m => m.id === currentVal)) sel.value = currentVal;
        }

        function savePreferences() {
            localStorage.setItem('aqua_pm_prefs', JSON.stringify({
                chatModel: document.getElementById('chat-model').value, imageModel: document.getElementById('image-model').value,
                imageRatio: document.getElementById('image-ratio').value, videoModel: document.getElementById('video-model').value
            }));
        }
        function loadPreferences() {
            try {
                const saved = JSON.parse(localStorage.getItem('aqua_pm_prefs'));
                if (saved) {
                    ['chat-model', 'image-model', 'image-ratio', 'video-model'].forEach(id => {
                        const key = id.replace(/-([a-z])/g, g => g[1].toUpperCase());
                        if (saved[key]) document.getElementById(id).value = saved[key];
                    });
                }
            } catch(e) {}
        }

        function setupImageUpload() {
            const zone = document.getElementById('upload-zone');
            zone.onclick = (e) => { if(e.target.tagName==='BUTTON') return; const i=document.createElement('input'); i.type='file'; i.accept='image/*'; i.multiple=true; i.onchange=e=>handleFiles(e.target.files); i.click(); };
            zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
            zone.ondragleave = e => { e.preventDefault(); zone.classList.remove('dragover'); };
            zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); };
            
            async function handleFiles(files) {
                if (!files || !files.length) return;
                for (let file of files) {
                    const tempId = Date.now() + Math.random();
                    uploadedImages.push({ id: tempId, url: '', status: 'uploading' });
                    renderImageQueue();
                    try {
                        const reader = new FileReader();
                        reader.readAsDataURL(file);
                        reader.onload = async (e) => {
                            const b64 = e.target.result;
                            const res = await fetch(CFG.ORIGIN + '/v1/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: b64 }) });
                            const data = await res.json();
                            if (data.url) { const uIt = uploadedImages.find(img => img.id === tempId); if (uIt) { uIt.url = data.url; uIt.status = 'done'; renderImageQueue();} } 
                            else throw new Error("上传失败");
                        }
                    } catch (e) { alert("转换失败: " + e.message); uploadedImages = uploadedImages.filter(img => img.id !== tempId); renderImageQueue(); }
                }
            }
        }
        function renderImageQueue() {
            document.getElementById('image-queue').innerHTML = uploadedImages.map(img => \`<div class="queue-item">\${img.status === 'uploading' ? '<div style="font-size:10px;text-align:center;margin-top:15px;">...</div>' : \`<img src="\${img.url}">\`}<button style="position:absolute;top:0;right:0;width:18px;height:18px;padding:0;font-size:10px;background:red;min-height:18px;" onclick="event.stopPropagation(); window.removeImage(\${img.id})">×</button></div>\`).join('');
            document.getElementById('image-queue').style.display = uploadedImages.length ? 'flex' : 'none';
        }
        window.removeImage = function(id) { uploadedImages = uploadedImages.filter(img => img.id !== id); renderImageQueue(); };
        function copyText(text) { navigator.clipboard.writeText(text); }

        async function fetchSSEWithRetry(url, options, onMessage) {
            try {
                const res = await fetch(url, options);
                if (!res.ok) throw new Error((await res.text()) || '网络错误');
                const reader = res.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = ''; 
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\\n');
                    buffer = lines.pop(); 
                    
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data:')) {
                            const data = trimmed.substring(5).trim();
                            if (data === '[DONE]') return;
                            if (data) onMessage(data);
                        }
                    }
                }
                if (buffer.trim().startsWith('data:')) {
                    const data = buffer.trim().substring(5).trim();
                    if (data && data !== '[DONE]') onMessage(data);
                }
            } catch (e) { throw e; }
        }

        function submitUserPrompt() {
            const promptInput = document.getElementById('prompt'); const prompt = promptInput.value.trim();
            const btn = document.getElementById('btn-send');
            
            if (btn.innerText.includes('中断')) { if (abortController) abortController.abort(); btn.innerHTML = '发送 🚀'; btn.style.background = 'var(--primary-color)'; return; }
            if (!prompt) return;
            if (uploadedImages.some(img => img.status === 'uploading')) { alert("请等待图像上传完成！"); return; }

            promptInput.value = ''; 
            const sendImagesUrls = uploadedImages.map(img => img.url); 
            
            let userHtml = prompt;
            if (sendImagesUrls.length) userHtml += '<div style="display:flex; gap:8px; margin-top:12px;">' + sendImagesUrls.map(url => \`<img src="\${url}" style="width:70px; height:70px; object-fit:cover; border-radius:8px;">\`).join('') + '</div>';
            
            const userMsgId = 'usr_' + Date.now();
            let userContent = sendImagesUrls.length ? [{ type: "text", text: prompt }, ...sendImagesUrls.map(url => ({ type: "image_url", image_url: { url } }))] : prompt;
            
            pushMessageToDOM({ id: userMsgId, role: 'user', content: userContent, html: userHtml });
            triggerAIGeneration();
        }

        async function triggerAIGeneration() {
            const lastUserMsg = [...currentSessionHistory].reverse().find(m => m.role === 'user');
            if (!lastUserMsg) return;

            let prompt = "";
            let imageUrls = [];
            if (typeof lastUserMsg.content === 'string') {
                prompt = lastUserMsg.content;
            } else {
                prompt = lastUserMsg.content.find(c => c.type === 'text')?.text || "";
                imageUrls = lastUserMsg.content.filter(c => c.type === 'image_url').map(c => c.image_url.url);
            }

            const aiMsgId = 'ai_' + Date.now();
            pushMessageToDOM({ id: aiMsgId, role: 'ai', content: '', html: '<span class="status-dot load" style="display:inline-block;width:10px;height:10px;background:var(--primary-color);border-radius:50%;animation:blink 1s infinite;"></span> 矩阵运算中...' });

            const btn = document.getElementById('btn-send');
            btn.innerHTML = '中断 🛑'; btn.style.background = 'var(--error-color)';
            abortController = new AbortController();

            try {
                if (currentMode === 'chat') await handleChat(aiMsgId);
                else if (currentMode === 'image') await handleImage(prompt, aiMsgId, imageUrls);
                else if (currentMode === 'video') await handleVideo(prompt, aiMsgId);
                else if (currentMode === 'tools') await handleTools(prompt, aiMsgId);
            } catch (e) {
                if (e.name !== 'AbortError') {
                    const aiMsg = currentSessionHistory.find(m => m.id === aiMsgId);
                    if(aiMsg) {
                        aiMsg.html = \`<div class="msg error">❌ 运算崩溃: \${e.message}</div>\`;
                        reRenderChatBox();
                    }
                    document.getElementById('auto-fallback-indicator').style.display = 'block';
                    setTimeout(() => document.getElementById('auto-fallback-indicator').style.display = 'none', 3000);
                }
            } finally {
                btn.innerHTML = '发送 🚀'; btn.style.background = 'var(--primary-color)';
                if (currentMode === 'image' || currentMode === 'chat') { uploadedImages = []; renderImageQueue(); }
            }
        }

        async function handleChat(aiMsgId) {
            const model = document.getElementById('chat-model').value; 
            let fullText = '';
            const aiMsgObj = currentSessionHistory.find(m => m.id === aiMsgId);
            
            const messagesPayload = currentSessionHistory
                .filter(m => m.id !== aiMsgId) 
                .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }));

            let renderPending = false;
            await fetchSSEWithRetry(CFG.ORIGIN + '/v1/chat/completions', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages: messagesPayload, stream: true }), signal: abortController.signal
            }, (data) => {
                try { 
                    const j = JSON.parse(data); 
                    if (j.choices && j.choices[0].delta && typeof j.choices[0].delta.content === 'string') { 
                        fullText += j.choices[0].delta.content; 
                        aiMsgObj.content = fullText;
                        if (!renderPending) {
                            renderPending = true;
                            requestAnimationFrame(async () => {
                                aiMsgObj.html = await renderMarkdownAsync(fullText) + '▌';
                                reRenderChatBox();
                                renderPending = false;
                            });
                        }
                    } 
                } catch(e) {} 
            });
            aiMsgObj.html = await renderMarkdownAsync(fullText);
            reRenderChatBox();
            updateTokenUI();
        }

        async function handleImage(prompt, aiMsgId, imageUrls) {
            const payload = { model: document.getElementById('image-model').value, prompt, size: document.getElementById('image-ratio').value, stream: true }; 
            if (imageUrls.length) { payload.images = imageUrls; payload.image = imageUrls[0]; }
            const aiMsgObj = currentSessionHistory.find(m => m.id === aiMsgId);
            
            aiMsgObj.html = '<div class="skeleton-media">🎨 分配计算节点并构建图层...</div>';
            reRenderChatBox();

            await fetchSSEWithRetry(CFG.ORIGIN + '/v1/images/generations', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), signal: abortController.signal
            }, (dataStr) => {
                try {
                    const data = JSON.parse(dataStr);
                    if (data.status === 'processing') aiMsgObj.html = \`<div class="skeleton-media">🎨 \${data.message}</div>\`;
                    else if (data.status === 'completed' || (data.data && data.data[0].url)) {
                        const finalUrl = data.url || data.data[0].url;
                        aiMsgObj.html = \`<img src="\${finalUrl}" style="width:100%; border-radius:12px; box-shadow:var(--glass-shadow);">\`;
                        aiMsgObj.content = "生成图像: " + prompt;
                        // 注入媒体 URL 用于下载机制
                        aiMsgObj.mediaUrl = finalUrl;
                        aiMsgObj.mediaType = 'image';
                    } else if (data.status === 'error') throw new Error(data.message);
                    reRenderChatBox();
                } catch(e) { if(e.message !== "Unexpected end of JSON input") throw e; }
            });
            updateTokenUI();
        }

        async function handleVideo(prompt, aiMsgId) {
            const payload = { model: document.getElementById('video-model').value, prompt, stream: true };
            const aiMsgObj = currentSessionHistory.find(m => m.id === aiMsgId);
            
            await fetchSSEWithRetry(CFG.ORIGIN + '/v1/video/generations', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), signal: abortController.signal
            }, (dataStr) => {
                try {
                    const data = JSON.parse(dataStr);
                    if (data.status === 'processing') {
                        const pct = data.progress || 0;
                        aiMsgObj.html = \`
                            <div style="font-weight:bold; color:var(--primary-color); margin-bottom:8px;">\${data.message} [\${pct}%]</div>
                            <div class="progress-container"><div class="progress-bar" style="width:\${pct}%;"></div></div>
                            <div class="skeleton-media" style="margin-top:12px;">🎬 渲染帧序列中...</div>\`;
                    } else if (data.status === 'completed' || (data.data && data.data[0].url)) {
                        const finalUrl = data.url || data.data[0].url;
                        aiMsgObj.html = \`<video src="\${finalUrl}" controls autoplay loop style="width:100%; border-radius:12px; box-shadow:var(--glass-shadow);"></video>\`;
                        aiMsgObj.content = "生成视频: " + prompt;
                        // 注入媒体 URL 用于下载机制
                        aiMsgObj.mediaUrl = finalUrl;
                        aiMsgObj.mediaType = 'video';
                    } else if (data.status === 'error') throw new Error(data.message);
                    reRenderChatBox();
                } catch(e) { if(e.message !== "Unexpected end of JSON input") throw e; }
            });
            updateTokenUI();
        }

        async function handleTools(prompt, aiMsgId) {
            const type = document.getElementById('tools-type').value;
            const res = await fetch(CFG.ORIGIN + '/v1/' + type, {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify(type === 'extract' ? { url: prompt } : { query: prompt }), signal: abortController.signal
            });
            if (!res.ok) throw new Error((await res.json()).detail || '节点执行崩溃');
            const data = await res.json();
            const aiMsgObj = currentSessionHistory.find(m => m.id === aiMsgId);
            
            if (type === 'extract' && data.content) {
                aiMsgObj.content = data.content;
                aiMsgObj.html = await renderMarkdownAsync(data.content);
            } else {
                const str = JSON.stringify(data, null, 2);
                aiMsgObj.content = str;
                aiMsgObj.html = \`<pre><code>\${str}</code></pre>\`;
            }
            reRenderChatBox();
            updateTokenUI();
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
