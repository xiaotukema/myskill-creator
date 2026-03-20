#!/usr/bin/env node

/**
 * OpenClaw Skill Creator Server
 * 
 * 提供 API 来:
 * 1. AI 生成 SKILL.md 内容
 * 2. 安装 Skill 到 OpenClaw
 * 
 * 使用方法:
 *   node skill-creator-server.js
 * 
 * 默认端口: 3456
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3456;
const SKILLS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw/workspace/skills');
const FETCH_TIMEOUT_MS = 20000;
let scraplingReady = false;

// AI 配置 - 支持 MiniMax / Gemini / Ollama
const AI_PROVIDER = process.env.AI_PROVIDER || 'minimax';  // 'minimax', 'gemini', 'ollama'
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// 确保 skills 目录存在
if (!fs.existsSync(SKILLS_DIR)) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function sanitizeSkillName(input, fallback = 'imported-skill') {
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, ' ')
    .trim();

  if (!normalized) return fallback;

  const asciiSlug = normalized
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);

  return asciiSlug || fallback;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToMarkdown(html) {
  if (!html) return '';
  let md = String(html);

  // 移除噪音
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // 常见标签转换
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 清理剩余标签
  md = md.replace(/<[^>]+>/g, ' ');
  md = decodeHtmlEntities(md);
  md = md.replace(/[ \t]+\n/g, '\n');
  md = md.replace(/\n{3,}/g, '\n\n');

  return md.trim();
}

function extractTitleFromText(content, fallback = 'Imported Skill') {
  const firstHeading = String(content || '').match(/^#\s+(.+)$/m);
  if (firstHeading?.[1]) return firstHeading[1].trim().substring(0, 120);
  return fallback;
}

function pickActionSteps(content) {
  const lines = String(content || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const candidates = lines.filter(line =>
    /^(\d+\.|-|\*)\s+/.test(line) ||
    /(点击|打开|创建|配置|安装|运行|部署|验证|提交|处理|提取|分析|生成|调用|检查|优化|click|open|create|configure|install|run|deploy|verify|submit|extract|analyze|generate)/i.test(line)
  );

  const selected = (candidates.length > 0 ? candidates : lines)
    .slice(0, 6)
    .map((line, idx) => {
      const cleaned = line
        .replace(/^(\d+\.|-|\*)\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
      return `${idx + 1}. ${cleaned}`;
    });

  if (selected.length === 0) {
    return [
      '1. 读取并理解网页标题与正文，识别核心目标。',
      '2. 提取可执行动作并整理为简洁步骤。',
      '3. 基于内容生成可复用的技能说明与触发条件。'
    ];
  }
  return selected;
}

function buildHeuristicSkillData(content, sourceUrl, pageTitle = '') {
  const title = pageTitle || extractTitleFromText(content, 'Imported Skill');
  const meaningfulLines = String(content || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 20 && !line.startsWith('#'))
    .slice(0, 3);

  const shortSummary = meaningfulLines.join(' ').substring(0, 220) || `从 ${sourceUrl} 导入的内容理解与执行技能。`;
  const skillName = sanitizeSkillName(title || sourceUrl);
  const steps = pickActionSteps(content).join('\n');

  return {
    skill_name: skillName,
    description: `该技能用于处理“${title}”相关任务，能够基于页面核心内容进行总结并执行关键步骤。${shortSummary}`.substring(0, 300),
    trigger_condition: `当用户需要处理“${title}”主题相关问题，或希望把该页面内容转化为可执行流程时使用此技能。`,
    instructions: steps
  };
}

function fetchTextByUrl(targetUrl, options = {}, redirectCount = 0) {
  const { URL } = require('url');
  const target = new URL(targetUrl);
  const client = target.protocol === 'http:' ? require('http') : require('https');

  return new Promise((resolve, reject) => {
    const req = client.get(targetUrl, options, (res) => {
      const statusCode = res.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        if (redirectCount >= 5) {
          reject(new Error('Too many redirects'));
          return;
        }
        const redirected = new URL(res.headers.location, targetUrl).toString();
        resolve(fetchTextByUrl(redirected, options, redirectCount + 1));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时(${FETCH_TIMEOUT_MS}ms)`));
    });
    req.on('error', reject);
  });
}

async function fetchWithJinaReader(targetUrl) {
  const jinaUrl = `https://r.jina.ai/${encodeURIComponent(targetUrl)}`;
  const content = await fetchTextByUrl(jinaUrl, { headers: { Accept: 'text/plain' } });
  return {
    strategy: 'jina-reader',
    content: content.trim(),
    title: extractTitleFromText(content, new URL(targetUrl).hostname)
  };
}

async function fetchWithScrapling(targetUrl) {
  await ensureScraplingReady();
  const escaped = targetUrl.replace(/"/g, '\\"');
  const cmd = `python3 - <<'PY'
import json
import sys
from scrapling.fetchers import Fetcher

url = "${escaped}"
fetcher = Fetcher()
resp = fetcher.get(url, stealthy_headers=True)
text = getattr(resp, "markdown", None) or getattr(resp, "text", "") or ""
title = getattr(resp, "title", None) or ""
print(json.dumps({"title": title, "content": text}))
PY`;

  const output = execSync(cmd, {
    encoding: 'utf8',
    timeout: FETCH_TIMEOUT_MS
  });
  const parsed = JSON.parse(output);
  return {
    strategy: 'scrapling',
    content: String(parsed.content || '').trim(),
    title: String(parsed.title || '').trim()
  };
}

async function ensureScraplingReady() {
  if (scraplingReady) return;

  try {
    execSync(`python3 - <<'PY'
import scrapling
print("ok")
PY`, { stdio: 'ignore', timeout: 5000 });
    scraplingReady = true;
    return;
  } catch (_) {
    console.log('未检测到 scrapling，尝试自动安装...');
  }

  // 自动安装 scrapling（优先用户态安装）
  try {
    execSync('python3 -m pip install --user scrapling', {
      stdio: 'pipe',
      timeout: 120000
    });
  } catch (installError) {
    // 某些环境禁用 --user，再尝试系统安装
    execSync('python3 -m pip install scrapling', {
      stdio: 'pipe',
      timeout: 120000
    });
  }

  execSync(`python3 - <<'PY'
import scrapling
print("ok")
PY`, { stdio: 'ignore', timeout: 5000 });

  scraplingReady = true;
  console.log('scrapling 安装完成并可用。');
}

async function fetchWithDirectHtml(targetUrl) {
  const rawHtml = await fetchTextByUrl(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 SkillCreatorBot/1.0'
    }
  });
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeHtmlEntities((titleMatch?.[1] || '').replace(/\s+/g, ' ').trim());
  const markdown = htmlToMarkdown(rawHtml);

  return {
    strategy: 'direct-html-markdown',
    content: markdown,
    title: title || extractTitleFromText(markdown, new URL(targetUrl).hostname)
  };
}

async function fetchWebContentWithFallback(targetUrl) {
  const attempts = [];
  const minLength = 200;

  // 1) Jina Reader
  try {
    const result = await fetchWithJinaReader(targetUrl);
    if (result.content.length >= minLength) {
      return { ...result, attempts };
    }
    attempts.push({ strategy: result.strategy, ok: false, reason: `内容过短(${result.content.length})` });
  } catch (e) {
    attempts.push({ strategy: 'jina-reader', ok: false, reason: e.message });
  }

  // 2) Scrapling
  try {
    const result = await fetchWithScrapling(targetUrl);
    if (result.content.length >= minLength) {
      return { ...result, attempts };
    }
    attempts.push({ strategy: result.strategy, ok: false, reason: `内容过短(${result.content.length})` });
  } catch (e) {
    attempts.push({ strategy: 'scrapling', ok: false, reason: e.message });
  }

  // 3) 直接抓取 + HTML 转 Markdown
  try {
    const directResult = await fetchWithDirectHtml(targetUrl);
    return { ...directResult, attempts };
  } catch (e) {
    attempts.push({ strategy: 'direct-html-markdown', ok: false, reason: e.message || String(e) });
    return {
      strategy: 'none',
      title: new URL(targetUrl).hostname,
      content: '',
      attempts
    };
  }
}

// AI 生成函数 - 使用增强的 Prompt 模板
async function generateSkillContent(prompt) {
  try {
    const axios = require('axios');

    // 注入基于规范的强化 Prompt 模板
    const augmentedPrompt = `
作为资深的 OpenClaw 智能体技能工程师，请将用户提供的资料转化为标准的 SKILL.md 格式文件。
请严格遵守以下工程规范：

1. YAML Frontmatter 规范:
   - name: 请识别核心动词（如 deploy-xxx, format-xxx），采用 kebab-case 命名。
   - description: 内容需控制在 1024 字符内，严禁使用任何 XML 标签（如 < 或 >）。必须采用"推行式"语气（例如："务必在用户要求/提及...时使用此技能，即使对方没有明确说明..."）。

2. Markdown 指令集架构规范:
   请按以下层级生成结构化逻辑：
   - 角色定义: 赋予执行此技能的 Agent 明确的专家身份。
   - 前置检查: 要求模型执行任务前检索相关的本地环境、配置或项目清单。
   - 分阶段流水线: 将核心任务分解为 3-5 个逻辑清晰的阶段，并在每个阶段后提供明确的"验证方式/条件"。
   - 错误回滚指令: 根据任务逻辑，生成遇到故障或执行失败时的备选方案和回滚手段。

以下是用户需要转化为 Skill 的原始提取资料：
-------------------
${prompt}
    `;

    const response = await axios.post('http://localhost:11434/api/generate', {
      model: 'llama3',
      prompt: augmentedPrompt,
      stream: false
    }, { timeout: 120000 });

    return response.response?.text || response.data?.response;
  } catch (e) {
    console.log('AI API 不可用，使用模板生成:', e.message);
    return null;
  }
}

// LLM 结构化提取函数
async function extractSkillFromContent(content, context = {}) {
  const sourceTitle = context.title || extractTitleFromText(content, 'Imported Skill');

  const extractPrompt = `
你是一个专业的 AI Skill 设计师。请根据网页标题与正文，将信息重写为“可复用、可封装”的 Skill 结构，而不是原文摘抄。

目标：输出 4 个 JSON 字段，严格只输出 JSON。

字段要求：
1) skill_name
- 小写英文 + 数字 + 连字符
- 体现技能能力，不要包含“guide/tutorial/article”等文章词

2) description
- 1~2 句，说明技能能帮助用户完成什么
- 结合标题与正文抽象，不要照抄<title>

3) trigger_condition
- 用“当用户需要...时使用该技能”风格
- 根据 skill_name + description 智能推断触发场景

4) instructions
- 必须是“动词驱动”的步骤（1. 2. 3.）
- 从正文提取动作和操作流程，去掉叙事、广告、作者介绍
- 若正文非流程文，也要提炼为可执行任务步骤

输出约束：
- 仅返回合法 JSON
- 不要 Markdown 代码块
- 不要额外解释

网页标题：${sourceTitle}
网页来源：${context.url || 'N/A'}
抓取方式：${context.fetchStrategy || 'unknown'}

网页正文：
---
${String(content || '').substring(0, 12000)}
---
`;

  let llmResponse = '';
  let skillData = null;

  try {
    const axios = require('axios');
    if (AI_PROVIDER === 'minimax') {
      if (!MINIMAX_API_KEY) {
        throw new Error('请设置 MINIMAX_API_KEY 环境变量');
      }

      const response = await axios.post('https://api.minimax.chat/v1/text/chatcompletion_v2', {
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: '你是专业的 AI Skill 设计专家，擅长从网页中提取可执行工作流。' },
          { role: 'user', content: extractPrompt }
        ],
        temperature: 0.4
      }, {
        headers: {
          'Authorization': `Bearer ${MINIMAX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      });

      llmResponse = response.data?.choices?.[0]?.message?.content || '';
    } else if (AI_PROVIDER === 'gemini') {
      if (!GEMINI_API_KEY) {
        throw new Error('请设置 GEMINI_API_KEY 环境变量');
      }

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: extractPrompt }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json'
          }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      );

      llmResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (AI_PROVIDER === 'ollama') {
      const response = await axios.post('http://localhost:11434/api/generate', {
        model: 'llama3',
        prompt: extractPrompt,
        format: 'json',
        stream: false
      }, { timeout: 120000 });

      llmResponse = response.data?.response || '';
    } else {
      throw new Error(`不支持的 AI 提供商: ${AI_PROVIDER}`);
    }

    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    skillData = JSON.parse(jsonMatch[0]);

    return {
      skill_name: sanitizeSkillName(skillData.skill_name, sanitizeSkillName(sourceTitle)),
      description: String(skillData.description || '').trim(),
      trigger_condition: String(skillData.trigger_condition || '').trim(),
      instructions: Array.isArray(skillData.instructions)
        ? skillData.instructions.join('\n')
        : String(skillData.instructions || '').trim()
    };
  } catch (e) {
    console.log('LLM 提取失败，切换启发式提取:', e.message);
    return buildHeuristicSkillData(content, context.url || '', sourceTitle);
  }
}

// 本地生成 skill 内容
function generateLocalSkill(data) {
  const { name, description, body, useCases, tools } = data;
  
  const useCasesSection = useCases ? `
## 使用场景

${useCases}
` : '';

  const toolsSection = tools ? `
## 需要用到的工具

${tools.split(',').map(t => `\`${t.trim()}\``).join(' ')}
` : '';

  const yamlDescription = description.split('\n').map((line, i) => 
    i === 0 ? `  ${line}` : `  ${line}`
  ).join('\n');

  return `---
name: ${name}
description: |
${yamlDescription}
---

# ${name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}

## 功能说明

${body}

${useCasesSection}${toolsSection}

---

*Generated by OpenClaw Skill Creator*
`;
}

// 安装 skill 到 OpenClaw
function installSkill(data) {
  const { name, content, bundled } = data;
  
  // 清理名称
  const skillName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const skillDir = path.join(SKILLS_DIR, skillName);
  
  // 创建 skill 目录
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  
  // 写入 SKILL.md
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillFile, content, 'utf8');
  
  // 创建并写入附加资源
  let resourcesMsg = '';
  
  if (bundled) {
    // references/
    if (bundled.references && bundled.references.length > 0) {
      const refsDir = path.join(skillDir, 'references');
      if (!fs.existsSync(refsDir)) {
        fs.mkdirSync(refsDir, { recursive: true });
      }
      bundled.references.forEach(ref => {
        const refFile = path.join(refsDir, ref.name);
        fs.writeFileSync(refFile, ref.content || '', 'utf8');
      });
      resourcesMsg += `\n- references/ (${bundled.references.length} 个文件)`;
    }
    
    // scripts/
    if (bundled.scripts && bundled.scripts.length > 0) {
      const scriptsDir = path.join(skillDir, 'scripts');
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }
      bundled.scripts.forEach(script => {
        const scriptFile = path.join(scriptsDir, script.name);
        fs.writeFileSync(scriptFile, script.content || '', 'utf8');
      });
      resourcesMsg += `\n- scripts/ (${bundled.scripts.length} 个文件)`;
    }
    
    // assets/
    if (bundled.assets && bundled.assets.length > 0) {
      const assetsDir = path.join(skillDir, 'assets');
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }
      bundled.assets.forEach(asset => {
        const assetFile = path.join(assetsDir, asset.name);
        fs.writeFileSync(assetFile, asset.content || '', 'utf8');
      });
      resourcesMsg += `\n- assets/ (${bundled.assets.length} 个文件)`;
    }
  }
  
  return {
    success: true,
    path: skillDir,
    message: `Skill "${skillName}" 已安装到 ${skillDir}${resourcesMsg ? '\n附加资源：' + resourcesMsg : ''}`
  };
}

// 获取已安装的 skills 列表
function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }
  
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const skillFile = path.join(SKILLS_DIR, dirent.name, 'SKILL.md');
      let description = '';
      
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf8');
        const match = content.match(/description:\s*\|\s*\n?([\s\S]*?)(?=---)/);
        if (match) {
          description = match[1].trim().replace(/\n/g, ' ').substring(0, 100);
        }
      }
      
      return {
        name: dirent.name,
        description: description || '无描述'
      };
    });
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 解析 URL
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 设置 JSON 响应头
  res.setHeader('Content-Type', 'application/json');

  try {
    // POST /api/generate-skill - AI 生成 skill
    if (req.method === 'POST' && pathname === '/api/generate-skill') {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
        req.on('error', reject);
      });

      // 优先尝试 AI 生成
      let content = await generateSkillContent(data.prompt);
      
      // 如果 AI 不可用，使用本地生成
      if (!content) {
        content = generateLocalSkill({
          name: body.name,
          description: body.description,
          body: body.body,
          useCases: body.useCases,
          tools: body.tools
        });
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, content }));
      return;
    }

    // POST /api/import-url - 从 URL 导入并生成 Skill（三级降级抓取 + LLM 结构化提取）
    if (req.method === 'POST' && pathname === '/api/import-url') {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
        req.on('error', reject);
      });

      const { url } = body;
      
      if (!url) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'URL is required' }));
        return;
      }

      try {
        // 三级降级抓取:
        // 1) Jina Reader 2) Scrapling 3) Direct HTML + Markdown
        const fetched = await fetchWebContentWithFallback(url);
        const content = fetched.content || '';

        // 使用 LLM 进行结构化提取（失败时启发式兜底）
        const structuredData = await extractSkillFromContent(content, {
          url,
          title: fetched.title,
          fetchStrategy: fetched.strategy
        });
        
        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true, 
          ...structuredData,
          rawContent: content,
          sourceTitle: fetched.title,
          fetchStrategy: fetched.strategy,
          fetchAttempts: fetched.attempts || [],
          url: url
        }));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // POST /api/skills/install - 安装 skill
    if (req.method === 'POST' && pathname === '/api/skills/install') {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
        req.on('error', reject);
      });

      const result = installSkill(body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/skills - 列出已安装的 skills
    if (req.method === 'GET' && pathname === '/api/skills') {
      const skills = listSkills();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, skills }));
      return;
    }

    // GET / - 提供静态 HTML
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const htmlPath = path.join(__dirname, 'skill-creator.html');
      
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    }

    // GET /skill-center.html - Skill 中心页面
    if (req.method === 'GET' && pathname === '/skill-center.html') {
      const htmlPath = path.join(__dirname, 'skill-center.html');
      
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    }

    // GET /my-skills.html - My Skills page
    if (req.method === 'GET' && pathname === '/my-skills.html') {
      const htmlPath = path.join(__dirname, 'my-skills.html');
      
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    }

    // GET /skill-guide.html - Skill Design Guide page
    if (req.method === 'GET' && pathname === '/skill-guide.html') {
      const htmlPath = path.join(__dirname, 'skill-guide.html');
      
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    }

    // GET /skill-test.html - Skill Testing page
    if (req.method === 'GET' && pathname === '/skill-test.html') {
      const htmlPath = path.join(__dirname, 'skill-test.html');
      
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (error) {
    console.error('Error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`
🎉 OpenClaw Skill Creator Server 运行中!

   本地访问: http://localhost:${PORT}
   Skills 目录: ${SKILLS_DIR}
   AI 提供商: ${AI_PROVIDER.toUpperCase()}

   API 端点:
   - POST /api/generate-skill  - AI 生成 skill
   - POST /api/import-url      - 从 URL 导入并生成 skill
   - POST /api/skills/install  - 安装 skill
   - GET  /api/skills          - 列出已安装的 skills

   环境变量说明:
   - AI_PROVIDER: ai 模型提供商 (minimax/gemini/ollama)
   - MINIMAX_API_KEY: MiniMax API 密钥
   - GEMINI_API_KEY: Gemini API 密钥
  `);
});
