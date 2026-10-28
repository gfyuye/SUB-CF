// 环境变量：
//   TOKEN / GUESTTOKEN / SELF_NODES / LINK / LINKSUB / SUBAPI / SUBCONFIG / SUBCONVERTER_UA
//   STRICT_SELF_NODES（0=宽松，1=严格，2=超严格）/ SUB_HOST_ALLOW / SUBNAME / SUBUPTIME
//   TGTOKEN / TGID / TG / URL / URL302

const DEFAULT_SUB_CONVERTER = "SUBAPI.fxxk.dedyn.io";
const DEFAULT_SUB_CONFIG = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
const DEFAULT_FILE_NAME = 'CF-Workers-SUB';
const DEFAULT_TOKEN = 'auto';
const DEFAULT_SUB_UPDATE_TIME = 6;

const MAX_SUBS = 60;
const MAX_RESP_BYTES = 5 * 1024 * 1024;
const CONCURRENCY = 10;
const BATCH_TIMEOUT_MS = 8000;
const GLOBAL_BUDGET_MS = 25000;
const MAX_REDIRECTS = 3;
const SELF_UA_TAG = 'cf-workers-sub';

const FAKE_TOKEN_WINDOW_MS = 10 * 60 * 1000;

const NODE_SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'ssr', 'hysteria', 'hysteria2', 'hy2', 'tuic'];

// ===== 真 64 位 FNV-1a（两轮不同乘法常量）=====
function fnv1a64Hex(str) {
	let h1 = 0x811c9dc5;
	let h2 = 0xcbf29ce4;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		h1 ^= c;
		h1 = Math.imul(h1, 0x01000193) >>> 0;
		h2 ^= c;
		h2 = Math.imul(h2, 0x01000197) >>> 0;
	}
	const a = h1.toString(16).padStart(8, '0');
	const b = h2.toString(16).padStart(8, '0');
	return a + b;
}

export default {
	async fetch(request, env, ctx) {
		let mytoken = env.TOKEN || DEFAULT_TOKEN;
		let guestToken = env.GUESTTOKEN || env.GUEST || '';
		const BotToken = env.TGTOKEN || '';
		const ChatID = env.TGID || '';
		const TG = env.TG || 0;
		let subConverter = env.SUBAPI || DEFAULT_SUB_CONVERTER;
		let subConfig = env.SUBCONFIG || DEFAULT_SUB_CONFIG;
		let subProtocol = 'https';
		let FileName = env.SUBNAME || DEFAULT_FILE_NAME;
		let SUBUpdateTime = env.SUBUPTIME || DEFAULT_SUB_UPDATE_TIME;
		const strictModeRaw = String(env.STRICT_SELF_NODES || '0');
		const strictSelfNodes = strictModeRaw === '1' || strictModeRaw === '2';
		const ultraStrict = strictModeRaw === '2';

		const subHostAllow = String(env.SUB_HOST_ALLOW || '')
			.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
		const subConverterUaExtra = String(env.SUBCONVERTER_UA || '').toLowerCase();

		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const url = new URL(request.url);
		const token = url.searchParams.get('token');

		if (subConverter.includes("http://")) {
			subConverter = subConverter.split("//")[1];
			subProtocol = 'http';
		} else {
			subConverter = subConverter.split("//")[1] || subConverter;
		}

		if (mytoken === 'auto') {
			if (String(env.ALLOW_AUTO_TOKEN) !== '1') {
				return new Response('Service not configured: TOKEN is missing.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
				});
			}
			console.warn('警告：TOKEN 仍为默认值 auto，请尽快在环境变量中设置 TOKEN');
		}

		const win = Math.floor(Date.now() / FAKE_TOKEN_WINDOW_MS);
		const fakeToken = await hashToken(`${mytoken}${win}`);
		const fakeTokenHash = await hashToken(fakeToken);
		const fakeTokenPrev = await hashToken(`${mytoken}${win - 1}`);

		const guestConfigured = !!guestToken;

		const pathSegments = url.pathname.split('/').filter(Boolean);
		let accessLevel = 'none';
		let isFakeTokenRequest = false;
		if (token && token === mytoken) {
			accessLevel = 'admin';
		} else if (pathSegments.length === 1 && pathSegments[0] === mytoken) {
			accessLevel = 'admin';
		} else if (token && guestConfigured && token === guestToken) {
			accessLevel = 'guest';
		} else if (token && (token === fakeToken || token === fakeTokenPrev)) {
			const okUa = userAgent.includes('subconverter')
				|| userAgent.includes(SELF_UA_TAG)
				|| (subConverterUaExtra && userAgent.includes(subConverterUaExtra));
			if (okUa) {
				accessLevel = 'guest';
				isFakeTokenRequest = true;
			}
		}
		const isValidAccess = accessLevel !== 'none';

		if (!isValidAccess) {
			if (!guestConfigured && token && token !== mytoken && token !== fakeToken && token !== fakeTokenPrev) {
				return new Response('访客订阅未启用：请设置 GUESTTOKEN 环境变量。', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
				});
			}
			if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") {
				ctx.waitUntil(sendMessage(BotToken, ChatID, `#异常访问 ${FileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgent}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname + redactSearch(url.search)}</tg-spoiler>`).catch(() => {}));
			}
			if (env.URL302) return Response.redirect(env.URL302, 302);
			else if (env.URL) return await proxyURL(env.URL, url);
			else return new Response(await nginx(), {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
			});
		}

		// ===== 自建节点与订阅源完全分开 =====
		const selfNodesRaw = String(env.SELF_NODES || '').trim();

		let urlLines = [];
		if (env.LINK) urlLines = urlLines.concat(await ADD(env.LINK));
		if (env.LINKSUB) urlLines = urlLines.concat(await ADD(env.LINKSUB));
		const urls = [...new Set(urlLines.filter(x => /^https?:\/\//i.test(x)))];

		ctx.waitUntil(sendMessage(BotToken, ChatID, `#获取订阅 ${FileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname + redactSearch(url.search)}</tg-spoiler>`).catch(() => {}));

		// ===== 判断订阅格式 =====
		let 订阅格式 = 'base64';
		if (url.searchParams.has('b64')) {
			订阅格式 = 'base64';
		} else if (userAgent.includes('null') || userAgent.includes('subconverter') || userAgent.includes('nekobox') || userAgent.includes(SELF_UA_TAG)) {
			订阅格式 = 'base64';
		} else if (userAgent.includes('clash') || (url.searchParams.has('clash') && !userAgent.includes('subconverter'))) {
			订阅格式 = 'clash';
		} else if (userAgent.includes('sing-box') || userAgent.includes('singbox') || ((url.searchParams.has('sb') || url.searchParams.has('singbox')) && !userAgent.includes('subconverter'))) {
			订阅格式 = 'singbox';
		} else if (userAgent.includes('surge') || (url.searchParams.has('surge') && !userAgent.includes('subconverter'))) {
			订阅格式 = 'surge';
		} else if (userAgent.includes('quantumult x') || userAgent.includes('quantumult%20x') || (url.searchParams.has('quanx') && !userAgent.includes('subconverter'))) {
			订阅格式 = 'quanx';
		} else if (userAgent.includes('loon') || (url.searchParams.has('loon') && !userAgent.includes('subconverter'))) {
			订阅格式 = 'loon';
		}

		let 追加UA = 'v2rayn';
		if (url.searchParams.has('clash')) 追加UA = 'clash';
		else if (url.searchParams.has('singbox')) 追加UA = 'singbox';
		else if (url.searchParams.has('surge')) 追加UA = 'surge';
		else if (url.searchParams.has('quanx')) 追加UA = 'Quantumult%20X';
		else if (url.searchParams.has('loon')) 追加UA = 'Loon';

		// ===== 拉取订阅源（不混淆）=====
		const 请求订阅响应内容 = await getSUB(urls, request, 追加UA, userAgentHeader, subHostAllow);
		const upstreamNodes = 请求订阅响应内容[0].join('\n');

		// ===== fakeToken 回拉：返回混淆后的自建节点 + 订阅源节点 =====
		if (isFakeTokenRequest) {
			const warnCtx = { base64DecodeFailures: [], ssrParamFailures: [] };
			const replacementsForRelay = new Map();
			const phToRealForRelay = new Map();
			const nodeMetaForRelay = new Map();
			const obfuscatedSelfForRelay = selfNodesRaw ? obfuscateSelfNodes(selfNodesRaw, replacementsForRelay, phToRealForRelay, nodeMetaForRelay, warnCtx) : '';
			flushWarnCtx(warnCtx);
			const relayContent = [obfuscatedSelfForRelay, upstreamNodes].filter(Boolean).join('\n');
			const relayBase64 = encodeBase64Safe(dedupeLines(relayContent));
			return new Response(relayBase64, {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Referrer-Policy": "no-referrer",
				},
			});
		}

		// ===== base64 请求：返回原文（自建节点原文 + 订阅源节点，不混淆）=====
		if (订阅格式 == 'base64') {
			const allNodes = [selfNodesRaw, upstreamNodes].filter(Boolean).join('\n');
			const base64Data = encodeBase64Safe(dedupeLines(allNodes));
			return new Response(base64Data, {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"Profile-Update-Interval": `${SUBUpdateTime}`,
					"Profile-web-page-url": request.url.includes('?') ? request.url.split('?')[0] : request.url,
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Referrer-Policy": "no-referrer",
				},
			});
		}

		// ===== 非 base64：混淆自建节点 → GET SUBAPI → 恢复 =====
		const warnCtx = { base64DecodeFailures: [], ssrParamFailures: [] };
		const replacements = new Map();
		const phToReal = new Map();
		const nodeMeta = new Map();
		// 修复遗漏 2：记录每个 nodeIndex 在 SELF_NODES 中的原始行号
		const nodeLineIndex = new Map();
		if (selfNodesRaw) obfuscateSelfNodes(selfNodesRaw, replacements, phToReal, nodeMeta, warnCtx, nodeLineIndex);
		flushWarnCtx(warnCtx);

		let 订阅转换URL = `${url.origin}/${fakeTokenHash}?token=${fakeToken}`;
		if (请求订阅响应内容[1]) 订阅转换URL += "|" + 请求订阅响应内容[1];

		const targetMap = { clash: 'clash', singbox: 'singbox', surge: 'surge', quanx: 'quanx', loon: 'loon' };
		const target = targetMap[订阅格式] || 'clash';
		let subConverterUrl = `${subProtocol}://${subConverter}/sub?target=${target}&url=${encodeURIComponent(订阅转换URL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
		if (订阅格式 === 'surge') subConverterUrl += '&ver=4';
		if (订阅格式 === 'quanx') subConverterUrl += '&udp=true';

		let resp;
		try {
			resp = await fetch(subConverterUrl, { headers: { 'User-Agent': userAgentHeader }, redirect: 'manual' });
		} catch (e) {
			return new Response(`SUBAPI 请求失败: ${e.message}`, {
				status: 502,
				headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
			});
		}
		if (!resp.ok) {
			return new Response(`SUBAPI 返回错误: ${resp.status} ${resp.statusText}`, {
				status: 502,
				headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
			});
		}

		let out = await resp.text();
		const restored = restorePlaceholdersStrict(out, replacements);
		if (restored === null) {
			const residual = checkResidual(out, replacements);
			console.error(`[P0] 恢复失败，残留占位符: ${residual || 'unknown'}。SUBAPI 可能改写了占位符（重命名/编码/格式校验）。`);
			return new Response(
				`订阅转换失败：SUBAPI 改写了占位符，无法精确恢复。请检查 SUBAPI 是否对域名/UUID/节点名做了改写。残留: ${residual || 'unknown'}`,
				{ status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
			);
		}
		out = restored;

		// foundAll 检测（missing / partial / unObfuscated）
		// 文档局限：多节点共用同一 real（server/password）时，out.includes(real) 无法区分该 real 属于哪个节点，
		//          一个节点丢字段、另一节点保留，丢字段的节点可能被判完整。这是 foundAll 的固有局限。
		const missingNodes = [];
		const partialNodes = [];
		const unObfuscatedNodes = [];
		for (const [idx, meta] of nodeMeta) {
			if (meta.unObfuscated) {
				unObfuscatedNodes.push(idx);
				continue;
			}
			let foundCount = 0;
			const total = meta.phs.size;
			for (const ph of meta.phs) {
				const real = phToReal.get(ph);
				if (real && out.includes(real)) foundCount++;
			}
			if (foundCount === 0) missingNodes.push(idx);
			else if (foundCount < total) partialNodes.push(idx);
		}
		const lineInfo = (idx) => {
			const ln = nodeLineIndex.get(idx);
			return ln != null ? `节点索引${idx}/行${ln + 1}` : `节点索引${idx}`;
		};
		if (missingNodes.length > 0 || partialNodes.length > 0 || unObfuscatedNodes.length > 0) {
			const parts = [];
			if (missingNodes.length > 0) parts.push(`${missingNodes.length} 个节点完全丢失（${missingNodes.map(lineInfo).join(', ')}）`);
			if (partialNodes.length > 0) parts.push(`${partialNodes.length} 个节点部分字段丢失（${partialNodes.map(lineInfo).join(', ')}）`);
			if (unObfuscatedNodes.length > 0) parts.push(`${unObfuscatedNodes.length} 个节点未混淆，无法检测完整性（${unObfuscatedNodes.map(lineInfo).join(', ')}）`);
			console.warn(`[P0/P2] ${parts.join('；')}`);
			const shouldFail = strictSelfNodes && (missingNodes.length > 0 || partialNodes.length > 0);
			const shouldFailUltra = ultraStrict && unObfuscatedNodes.length > 0;
			if (shouldFail || shouldFailUltra) {
				return new Response(
					`订阅转换失败：${parts.join('；')}（STRICT_SELF_NODES=${strictModeRaw}）。\n` +
					`如需返回仅机场节点（或无残缺节点）的订阅，请设 STRICT_SELF_NODES=0 或删除该环境变量后重试。\n` +
					`如需自建节点完整，请用 ?b64 直连（base64 路径不经 SUBAPI，自建节点完整）。\n` +
					`注意：多节点共用同一 server/password 时，严格检测无法精确判断单节点字段丢失（已知局限）。`,
					{ status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
				);
			}
		}

		if (订阅格式 === 'clash') out = await clashFix(out);

		const responseHeaders = {
			"content-type": "text/plain; charset=utf-8",
			"Profile-Update-Interval": `${SUBUpdateTime}`,
			"Profile-web-page-url": request.url.includes('?') ? request.url.split('?')[0] : request.url,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
		};
		// 修复 H2：X-Warning 加 CORS 暴露头，让浏览器 JS 能读
		if (unObfuscatedNodes.length > 0) {
			responseHeaders["X-Warning"] = `${unObfuscatedNodes.length} nodes un-obfuscated, integrity not guaranteed`;
			responseHeaders["Access-Control-Expose-Headers"] = "X-Warning";
		}
		if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(FileName)}`;
		return new Response(out, { headers: responseHeaders });
	}
};

// ===== 真 64 位占位符 =====

function deterministicPlaceholder(type, real, salt = '') {
	const h = fnv1a64Hex(`${type}:${real}${salt}`);
	switch (type) {
		case 'server':   return `ph-server-${h}.example.com`;
		case 'sni':      return `ph-sni-${h}.example.com`;
		case 'host':     return `ph-host-${h}.example.com`;
		case 'uuid':     return `00000000-0000-4000-8000-${h.slice(0, 12)}`;
		case 'pbk':      return `PH_PBK_${h.toUpperCase()}_BASE64SAFE`;
		case 'password': return `__PH_PASSWORD_${h.toUpperCase()}__`;
		case 'auth':     return `__PH_AUTH_${h.toUpperCase()}__`;
		default:         return `__PH_${String(type).toUpperCase()}_${h.toUpperCase()}__`;
	}
}

function makeKey(nodeIndex, type, real) {
	return `${nodeIndex}\x00${type}\x00${real}`;
}

function mapReal(real, type, nodeIndex, replacements, phToReal, nodeMeta) {
	if (!real) return real;
	const key = makeKey(nodeIndex, type, real);
	if (replacements.has(key)) return replacements.get(key);
	let placeholder = deterministicPlaceholder(type, real);
	if (phToReal && phToReal.has(placeholder)) {
		const existingReal = phToReal.get(placeholder);
		if (existingReal !== real) {
			console.error(`[P1] 占位符碰撞：type=${type}, node=${nodeIndex}，两个不同 real 生成同一 ph。加 salt 后缀。`);
			let salt = 1;
			let resolved = false;
			while (salt < 100) {
				placeholder = deterministicPlaceholder(type, real, `:${salt}`);
				if (!phToReal.has(placeholder)) { resolved = true; break; }
				salt++;
			}
			if (!resolved) {
				throw new Error(`占位符碰撞无法解决：type=${type}, node=${nodeIndex}，salt 已试到 100`);
			}
		}
	}
	replacements.set(key, placeholder);
	if (phToReal) phToReal.set(placeholder, real);
	if (nodeMeta) {
		// 修复 M5：set 前 if (!has)，避免覆盖已有记录
		if (!nodeMeta.has(nodeIndex)) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: false });
		nodeMeta.get(nodeIndex).phs.add(placeholder);
	}
	return placeholder;
}

function obfuscateSelfNodes(selfNodesRaw, replacements, phToReal, nodeMeta, warnCtx, nodeLineIndex) {
	const lines = selfNodesRaw.split('\n');
	const out = [];
	let nodeIndex = 0;
	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			out.push(line);
			continue;
		}
		if (nodeLineIndex) nodeLineIndex.set(nodeIndex, lineNo);
		out.push(obfuscateOneNode(line, nodeIndex, replacements, phToReal, nodeMeta, warnCtx));
		nodeIndex++;
	}
	return out.join('\n');
}

function obfuscateOneNode(line, nodeIndex, replacements, phToReal, nodeMeta, warnCtx) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) return line;
	const scheme = detectScheme(trimmed);
	if (!scheme) {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		console.warn(`[P2] 节点 ${nodeIndex} 的 scheme 无法识别（非标准协议），未混淆，无法检测完整性: ${safeNodeHost(trimmed)}`);
		return line;
	}
	try {
		switch (scheme) {
			case 'vless':
			case 'trojan':
			case 'tuic':
			case 'hysteria':
			case 'hysteria2':
			case 'hy2':
				return obfuscateUserPassURI(trimmed, scheme, nodeIndex, replacements, phToReal, nodeMeta, warnCtx);
			case 'vmess':
				return obfuscateVmess(trimmed, nodeIndex, replacements, phToReal, nodeMeta, warnCtx);
			case 'ss':
				return obfuscateSS(trimmed, nodeIndex, replacements, phToReal, nodeMeta, warnCtx);
			case 'ssr':
				return obfuscateSSR(trimmed, nodeIndex, replacements, phToReal, nodeMeta, warnCtx);
			default:
				if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
				console.warn(`[P2] 节点 ${nodeIndex} 的 scheme 不支持，未混淆: ${scheme}`);
				return line;
		}
	} catch (e) {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		console.warn(`混淆节点失败（保留原文）: ${safeNodeHost(trimmed)}`, e.message);
		return line;
	}
}

function detectScheme(s) {
	const lower = s.toLowerCase();
	for (const sc of NODE_SCHEMES) {
		if (lower.startsWith(sc + '://')) return sc;
	}
	return null;
}

function tryBase64Decode(str, warnCtx) {
	if (!str || str.length < 8) return null;
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(str)) return null;
	try {
		const decoded = base64DecodeSafe(str);
		if (!decoded) return null;
		if (!/^[\x20-\x7e]+$/.test(decoded)) return null;
		const reencoded = encodeBase64Safe(decoded).replace(/=+$/, '');
		const originalClean = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
		if (reencoded !== originalClean) {
			if (warnCtx) warnCtx.base64DecodeFailures.push('round-trip');
			return null;
		}
		if (!decoded.includes(':')) return null;
		return decoded;
	} catch { return null; }
}

// 修复 M2：counts 用 Object.create(null)，防原型污染
function flushWarnCtx(warnCtx) {
	if (!warnCtx) return;
	if (warnCtx.base64DecodeFailures.length > 0) {
		const counts = Object.create(null);
		for (const r of warnCtx.base64DecodeFailures) counts[r] = (counts[r] || 0) + 1;
		console.warn(`[P2] tryBase64Decode 失败汇总:`, counts);
	}
	if (warnCtx.ssrParamFailures.length > 0) {
		const counts = Object.create(null);
		for (const r of warnCtx.ssrParamFailures) counts[r] = (counts[r] || 0) + 1;
		console.warn(`[P2] SSR 参数解码失败汇总:`, counts);
	}
}

function obfuscateUserPassURI(line, scheme, nodeIndex, replacements, phToReal, nodeMeta, warnCtx) {
	const prefix = `${scheme}://`;
	const rest = line.slice(prefix.length);
	const hashIdx = rest.indexOf('#');
	const beforeHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
	const hash = hashIdx >= 0 ? rest.slice(hashIdx) : '';

	const atIdx = beforeHash.indexOf('@');
	if (atIdx < 0) {
		// 修复 M6：atIdx < 0 加 warn，与其他分支一致
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		console.warn(`[P2] ${scheme} 节点 ${nodeIndex} 无 @ 分隔符，未混淆: ${safeNodeHost(line)}`);
		return line;
	}

	const userPart = beforeHash.slice(0, atIdx);
	const hostPortQuery = beforeHash.slice(atIdx + 1);

	let newUser;
	if (scheme === 'hysteria') {
		const inner = tryBase64Decode(userPart, warnCtx);
		if (inner) {
			const colon = inner.indexOf(':');
			const user = inner.slice(0, colon);
			const pass = inner.slice(colon + 1);
			const newUserPart = mapReal(user, 'auth', nodeIndex, replacements, phToReal, nodeMeta);
			const newPassPart = mapReal(pass, 'auth', nodeIndex, replacements, phToReal, nodeMeta);
			newUser = encodeBase64Safe(`${newUserPart}:${newPassPart}`);
		} else {
			newUser = mapReal(userPart, 'auth', nodeIndex, replacements, phToReal, nodeMeta);
		}
	} else {
		let userType = 'password';
		if (scheme === 'vless' || scheme === 'vmess' || scheme === 'tuic') userType = 'uuid';
		newUser = mapReal(userPart, userType, nodeIndex, replacements, phToReal, nodeMeta);
	}

	const qIdx = hostPortQuery.indexOf('?');
	const hostPort = qIdx >= 0 ? hostPortQuery.slice(0, qIdx) : hostPortQuery;
	const queryStr = qIdx >= 0 ? hostPortQuery.slice(qIdx + 1) : '';

	const colonIdx = hostPort.lastIndexOf(':');
	const host = colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
	const port = colonIdx > 0 ? hostPort.slice(colonIdx) : '';
	const newHost = mapReal(stripBrackets(host), 'server', nodeIndex, replacements, phToReal, nodeMeta);
	const hostForUrl = /:/.test(newHost) ? `[${newHost}]` : newHost;

	const newQuery = obfuscateQueryString(queryStr, nodeIndex, replacements, phToReal, nodeMeta);

	return `${prefix}${newUser}@${hostForUrl}${port}${newQuery ? '?' + newQuery : ''}${hash}`;
}

function obfuscateQueryString(queryStr, nodeIndex, replacements, phToReal, nodeMeta) {
	if (!queryStr) return queryStr;
	const parts = queryStr.split('&');
	const out = [];
	for (const part of parts) {
		const eq = part.indexOf('=');
		if (eq < 0) { out.push(part); continue; }
		const key = part.slice(0, eq).toLowerCase();
		let val = part.slice(eq + 1);
		if (key === 'sni' || key === 'peer' || key === 'servername') {
			val = mapReal(safeDecode(val), 'sni', nodeIndex, replacements, phToReal, nodeMeta);
			val = encodeURIComponent(val);
		} else if (key === 'host') {
			val = mapReal(safeDecode(val), 'host', nodeIndex, replacements, phToReal, nodeMeta);
			val = encodeURIComponent(val);
		} else if (key === 'pbk') {
			val = mapReal(safeDecode(val), 'pbk', nodeIndex, replacements, phToReal, nodeMeta);
			val = encodeURIComponent(val);
		}
		out.push(`${part.slice(0, eq)}=${val}`);
	}
	return out.join('&');
}

function obfuscateVmess(line, nodeIndex, replacements, phToReal, nodeMeta, warnCtx) {
	const prefix = 'vmess://';
	const rest = line.slice(prefix.length);
	if (rest.includes('@')) {
		return obfuscateUserPassURI(line, 'vmess', nodeIndex, replacements, phToReal, nodeMeta, warnCtx);
	}
	let json;
	try { json = JSON.parse(base64DecodeSafe(rest)); } catch (e) {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		console.warn(`[P2] vmess 节点不是 JSON 格式，未混淆: ${safeNodeHost(line)}`, e.message);
		return line;
	}
	if (json.add) json.add = mapReal(json.add, 'server', nodeIndex, replacements, phToReal, nodeMeta);
	if (json.id) json.id = mapReal(json.id, 'uuid', nodeIndex, replacements, phToReal, nodeMeta);
	if (json.sni) json.sni = mapReal(json.sni, 'sni', nodeIndex, replacements, phToReal, nodeMeta);
	if (json.host) json.host = mapReal(json.host, 'host', nodeIndex, replacements, phToReal, nodeMeta);
	if (json.pbk) json.pbk = mapReal(json.pbk, 'pbk', nodeIndex, replacements, phToReal, nodeMeta);
	try {
		return prefix + encodeBase64Safe(JSON.stringify(json));
	} catch { return line; }
}

function obfuscateSS(line, nodeIndex, replacements, phToReal, nodeMeta, warnCtx) {
	const prefix = 'ss://';
	const rest = line.slice(prefix.length);
	const hashIdx = rest.indexOf('#');
	const beforeHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
	const hash = hashIdx >= 0 ? rest.slice(hashIdx) : '';

	if (beforeHash.includes('@')) {
		const atIdx = beforeHash.lastIndexOf('@');
		const userB64 = beforeHash.slice(0, atIdx);
		const hostPort = beforeHash.slice(atIdx + 1);
		let methodPass;
		try { methodPass = base64DecodeSafe(userB64); } catch {
			if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
			return line;
		}
		const colon = methodPass.indexOf(':');
		if (colon < 0) {
			if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
			return line;
		}
		const method = methodPass.slice(0, colon);
		const password = methodPass.slice(colon + 1);
		const newPassword = mapReal(password, 'password', nodeIndex, replacements, phToReal, nodeMeta);
		const newUser = encodeBase64Safe(method + ':' + newPassword);
		const colonIdx = hostPort.lastIndexOf(':');
		const host = colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
		const port = colonIdx > 0 ? hostPort.slice(colonIdx) : '';
		const newHost = mapReal(stripBrackets(host), 'server', nodeIndex, replacements, phToReal, nodeMeta);
		const hostForUrl = /:/.test(newHost) ? `[${newHost}]` : newHost;
		return `${prefix}${newUser}@${hostForUrl}${port}${hash}`;
	}

	let decoded;
	try { decoded = base64DecodeSafe(beforeHash); } catch {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		return line;
	}
	const atIdx = decoded.lastIndexOf('@');
	if (atIdx < 0) {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		return line;
	}
	const methodPass = decoded.slice(0, atIdx);
	const hostPort = decoded.slice(atIdx + 1);
	const colon = methodPass.indexOf(':');
	if (colon < 0) {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		return line;
	}
	const method = methodPass.slice(0, colon);
	const password = methodPass.slice(colon + 1);
	const newPassword = mapReal(password, 'password', nodeIndex, replacements, phToReal, nodeMeta);
	const hpColon = hostPort.lastIndexOf(':');
	const host = hpColon > 0 ? hostPort.slice(0, hpColon) : hostPort;
	const port = hpColon > 0 ? hostPort.slice(hpColon) : '';
	const newHost = mapReal(stripBrackets(host), 'server', nodeIndex, replacements, phToReal, nodeMeta);
	const hostForUrl = /:/.test(newHost) ? `[${newHost}]` : newHost;
	const newDecoded = `${method}:${newPassword}@${hostForUrl}${port}`;
	return `${prefix}${encodeBase64Safe(newDecoded)}${hash}`;
}

function obfuscateSSR(line, nodeIndex, replacements, phToReal, nodeMeta, warnCtx) {
	const prefix = 'ssr://';
	const rest = line.slice(prefix.length);
	let decoded;
	try { decoded = base64DecodeSafe(rest); } catch {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		return line;
	}
	const slashIdx = decoded.indexOf('/?');
	const mainPart = slashIdx >= 0 ? decoded.slice(0, slashIdx) : decoded;
	const paramsPart = slashIdx >= 0 ? decoded.slice(slashIdx + 2) : '';
	const parts = mainPart.split(':');
	if (parts.length < 6) {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		return line;
	}
	const [host, port, protocol, method, obfs, passB64] = parts;
	let password;
	try { password = base64DecodeSafe(passB64); } catch {
		if (nodeMeta) nodeMeta.set(nodeIndex, { phs: new Set(), unObfuscated: true });
		return line;
	}
	const newPassword = mapReal(password, 'password', nodeIndex, replacements, phToReal, nodeMeta);
	const newHost = mapReal(stripBrackets(host), 'server', nodeIndex, replacements, phToReal, nodeMeta);
	const newPassB64 = encodeBase64Safe(newPassword).replace(/=+$/, '');
	const newMain = [newHost, port, protocol, method, obfs, newPassB64].join(':');
	const newParams = obfuscateSSRParams(paramsPart, nodeIndex, replacements, phToReal, nodeMeta, warnCtx);
	const newDecoded = newParams ? `${newMain}/?${newParams}` : newMain;
	return prefix + encodeBase64Safe(newDecoded).replace(/=+$/, '');
}

function obfuscateSSRParams(paramsPart, nodeIndex, replacements, phToReal, nodeMeta, warnCtx) {
	if (!paramsPart) return paramsPart;
	const parts = paramsPart.split('&');
	const out = [];
	for (const part of parts) {
		const eq = part.indexOf('=');
		if (eq < 0) { out.push(part); continue; }
		const key = part.slice(0, eq).toLowerCase();
		let val = part.slice(eq + 1);
		if (key === 'obfsparam' || key === 'protoparam' || key === 'remarks') {
			let inner;
			try { inner = base64DecodeSafe(urlSafeBase64Decode(val)); } catch { inner = null; }
			if (inner) {
				const newInner = mapReal(inner, 'host', nodeIndex, replacements, phToReal, nodeMeta);
				val = urlSafeBase64Encode(newInner);
			} else if (key !== 'remarks' && warnCtx) {
				warnCtx.ssrParamFailures.push(key);
			}
		}
		out.push(`${part.slice(0, eq)}=${val}`);
	}
	return out.join('&');
}

// ===== 恢复：严格模式，失败返回 null =====

function restorePlaceholdersStrict(text, replacements) {
	// key 格式 ${nodeIndex}\x00${type}\x00${real}；real 不含 \x00（实际不会），slice(2).join('\x00') 正确
	const entries = [...replacements.entries()].map(([key, ph]) => {
		const parts = key.split('\x00');
		const real = parts.slice(2).join('\x00');
		return [real, ph];
	});
	const sorted = entries.sort((a, b) => b[1].length - a[1].length);
	let out = text;
	for (const [real, ph] of sorted) {
		out = out.split(ph).join(real);
	}
	if (checkResidual(out, replacements)) return null;
	return out;
}

function checkResidual(text, replacements) {
	if (!replacements || replacements.size === 0) return null;
	const phs = [...new Set([...replacements.values()])];
	for (const ph of phs) {
		if (text.includes(ph)) return ph;
	}
	return null;
}

// ===== 工具函数 =====

async function ADD(envadd) {
	if (!envadd) return [];
	let addtext = String(envadd).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (addtext.startsWith('\n')) addtext = addtext.slice(1);
	if (addtext.endsWith('\n')) addtext = addtext.slice(0, -1);
	const lines = addtext.split('\n').map(s => s.trim()).filter(Boolean);
	const out = [];
	for (const s of lines) {
		if (s.startsWith('http')) {
			if (isSafeSubUrl(s)) out.push(s);
			else console.warn(`[P2] 订阅源 URL 含非法字符（如 | 或换行），已跳过: ${safeHost(s)}`);
		} else {
			out.push(s);
		}
	}
	return out;
}

function encodeBase64Safe(data) {
	const str = String(data == null ? '' : data);
	try {
		return btoa(str);
	} catch (e) {
		const binary = new TextEncoder().encode(str);
		let base64 = '';
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
		for (let i = 0; i < binary.length; i += 3) {
			const b1 = binary[i];
			const b2 = binary[i + 1] || 0;
			const b3 = binary[i + 2] || 0;
			base64 += chars[b1 >> 2];
			base64 += chars[((b1 & 3) << 4) | (b2 >> 4)];
			base64 += chars[((b2 & 15) << 2) | (b3 >> 6)];
			base64 += chars[b3 & 63];
		}
		const padding = 3 - (binary.length % 3 || 3);
		return base64.slice(0, base64.length - padding) + '=='.slice(0, padding);
	}
}

function base64DecodeSafe(str) {
	let clean = String(str).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	const pad = (4 - (clean.length % 4)) % 4;
	clean += '='.repeat(pad);
	const bin = atob(clean);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder('utf-8').decode(bytes);
}

function urlSafeBase64Decode(input) {
	return base64DecodeSafe(input);
}

function urlSafeBase64Encode(input) {
	return encodeBase64Safe(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dedupeLines(text) {
	if (!text) return '';
	return [...new Set(String(text).split('\n').map(s => s.trim()).filter(Boolean))].join('\n');
}

function stripBrackets(host) {
	return String(host).replace(/^\[|\]$/g, '');
}

function safeDecode(v) {
	try { return decodeURIComponent(v); } catch { return v; }
}

function safeNodeHost(line) {
	const m = line.match(/@([^:?#\/]+)/);
	return m ? m[1] : 'unknown';
}

async function hashToken(text) {
	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(text)));
	const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
	return hex.slice(0, 32).toLowerCase();
}

function clashFix(content) {
	if (content.includes('wireguard') && !content.includes('remote-dns-resolve')) {
		const lines = content.includes('\r\n') ? content.split('\r\n') : content.split('\n');
		let result = "";
		const 备改内容 = ', mtu: 1280, udp: true';
		const 正确内容 = ', mtu: 1280, remote-dns-resolve: true, udp: true';
		for (const line of lines) {
			if (line.includes('type: wireguard')) {
				result += line.replace(备改内容, 正确内容) + '\n';
			} else {
				result += line + '\n';
			}
		}
		content = result;
	}
	return content;
}

function isPrivateHost(hostname) {
	const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
	if (!h) return true;
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		return false;
	}
	if (h.includes(':')) {
		if (h === '::' || h === '::1') return true;
		const mappedDot = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
		if (mappedDot) return isPrivateHost(mappedDot[1]);
		const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (mappedHex) {
			const hi = parseInt(mappedHex[1], 16);
			const lo = parseInt(mappedHex[2], 16);
			return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
		if (h === 'fe80::' || /^fe[89ab][0-9a-f]:/.test(h)) return true;
		if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
		if (/^fe[c-f][0-9a-f]:/.test(h)) return true;
		return false;
	}
	return false;
}

async function proxyURL(proxyURL, url) {
	const URLs = await ADD(proxyURL);
	const fullURL = URLs[Math.floor(Math.random() * URLs.length)];
	let parsedURL;
	try { parsedURL = new URL(fullURL); } catch { return new Response('Bad proxy target', { status: 502 }); }
	if (!['http:', 'https:'].includes(parsedURL.protocol)) return new Response('Bad proxy protocol', { status: 502 });
	if (isPrivateHost(parsedURL.hostname)) return new Response('Forbidden proxy target', { status: 403 });
	if (parsedURL.port && parsedURL.port !== '80' && parsedURL.port !== '443') return new Response('Forbidden proxy port', { status: 403 });
	let URLPathname = parsedURL.pathname;
	if (URLPathname.endsWith('/')) URLPathname = URLPathname.slice(0, -1);
	let newURL;
	try {
		const joined = new URL(URLPathname + url.pathname, `${parsedURL.protocol}//${parsedURL.hostname}`);
		newURL = `${parsedURL.protocol}//${parsedURL.hostname}${joined.pathname}${parsedURL.search}`;
	} catch { return new Response('Bad proxy path', { status: 502 }); }
	let response = await fetch(newURL, { redirect: 'manual' });
	if (response.status >= 300 && response.status < 400) {
		return new Response(null, {
			status: response.status,
			headers: { Location: response.headers.get('Location') || '/', 'Cache-Control': 'no-store' },
		});
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function getSUB(api, request, 追加UA, userAgentHeader, allowHosts) {
	if (!api || api.length === 0) return [[], ''];
	api = [...new Set(api)];
	if (api.length > MAX_SUBS) {
		console.warn(`订阅源数量 ${api.length} 超过上限 ${MAX_SUBS}，已截断`);
		api = api.slice(0, MAX_SUBS);
	}
	let newapi = "";
	let 订阅转换URLs = "";
	let 异常订阅 = "";
	try {
		const deadline = Date.now() + GLOBAL_BUDGET_MS;
		const allResponses = [];
		for (let i = 0; i < api.length; i += CONCURRENCY) {
			if (Date.now() >= deadline) {
				console.warn(`订阅源处理超预算，剩余 ${api.length - i} 个源跳过`);
				break;
			}
			const batch = api.slice(i, i + CONCURRENCY);
			const controller = new AbortController();
			const remain = Math.max(1000, deadline - Date.now());
			const timeout = setTimeout(() => controller.abort(), Math.min(BATCH_TIMEOUT_MS, remain));
			try {
				const batchRes = await Promise.allSettled(batch.map(apiUrl =>
					getUrlLimited(request, apiUrl, 追加UA, userAgentHeader, controller.signal, allowHosts)
				));
				allResponses.push(...batchRes.map((r, j) => ({ r, apiUrl: batch[j] })));
			} finally {
				clearTimeout(timeout);
			}
		}
		const modifiedResponses = allResponses.map(({ r: response, apiUrl }) => {
			if (response.status === 'rejected') {
				const reason = response.reason;
				if (reason && (reason.name === 'AbortError' || reason.message === 'timeout')) {
					return { status: '超时', value: null, apiUrl };
				}
				return { status: '请求失败', value: null, apiUrl };
			}
			return { status: 'fulfilled', value: response.value, apiUrl };
		});
		for (const response of modifiedResponses) {
			if (response.status === 'fulfilled') {
				const content = response.value || 'null';
				if (content.includes('proxies:')) {
					if (isSafeSubUrl(response.apiUrl)) 订阅转换URLs += "|" + response.apiUrl;
				} else if (content.includes('outbounds"') && content.includes('inbounds"')) {
					if (isSafeSubUrl(response.apiUrl)) 订阅转换URLs += "|" + response.apiUrl;
				} else if (content.includes('://')) {
					newapi += content + '\n';
				} else if (isValidBase64(content)) {
					const decoded = base64DecodeSafe(content);
					if (decoded && (decoded.includes('://') || decoded.includes('proxies:'))) {
						newapi += decoded + '\n';
					} else {
						异常订阅 += `# 异常订阅（内容无法解析）: ${safeHost(response.apiUrl)}\n`;
					}
				} else {
					异常订阅 += `# 异常订阅（内容无法解析）: ${safeHost(response.apiUrl)}\n`;
				}
			}
		}
	} catch (error) {
		console.error(error);
	}
	const 订阅内容 = await ADD(newapi + 异常订阅);
	return [订阅内容, 订阅转换URLs];
}

async function getUrlLimited(request, targetUrl, 追加UA, userAgentHeader, signal, allowHosts) {
	const response = await getUrl(request, targetUrl, 追加UA, userAgentHeader, signal, allowHosts);
	if (!response.ok) throw response;
	const reader = response.body && response.body.getReader ? response.body.getReader() : null;
	if (!reader) {
		const text = await response.text();
		const bytes = new TextEncoder().encode(text).length;
		if (bytes > MAX_RESP_BYTES) throw new Error('响应超过大小上限');
		return text;
	}
	const chunks = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_RESP_BYTES) {
			try { await reader.cancel(); } catch {}
			throw new Error('响应超过大小上限');
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(size);
	let off = 0;
	for (const c of chunks) { buf.set(c, off); off += c.length; }
	return new TextDecoder('utf-8').decode(buf);
}

async function getUrl(request, targetUrl, 追加UA, userAgentHeader, signal, allowHosts) {
	const newHeaders = new Headers();
	newHeaders.set('Accept', request.headers.get('Accept') || '*/*');
	newHeaders.set('Accept-Language', request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9');
	const safeUA = String(userAgentHeader || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
	newHeaders.set("User-Agent", `v2rayN/6.45 cmliu/CF-Workers-SUB ${追加UA}(${safeUA})`);
	let current = targetUrl;
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		let parsed;
		try { parsed = new URL(current); } catch { throw new Error('订阅源 URL 非法: ' + safeHost(current)); }
		if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('订阅源协议不允许: ' + parsed.protocol);
		if (isPrivateHost(parsed.hostname)) throw new Error('订阅源指向内网地址，已拒绝: ' + parsed.hostname);
		if (parsed.port && parsed.port !== '80' && parsed.port !== '443') throw new Error('订阅源端口不允许: ' + parsed.port);
		if (!isAllowedSubHost(parsed.hostname, allowHosts)) throw new Error('订阅源域名不在白名单: ' + parsed.hostname);
		const res = await fetch(current, { method: "GET", headers: newHeaders, redirect: "manual", signal });
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('Location');
			if (!loc) return res;
			try { current = new URL(loc, current).toString(); } catch { return res; }
			continue;
		}
		return res;
	}
	throw new Error('订阅源重定向次数超过上限');
}

function isValidBase64(str) {
	if (!str) return false;
	let clean = String(str).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
	if (clean.length < 32) return false;
	clean = clean.replace(/=+$/, '');
	if (!/^[A-Za-z0-9+/]+$/.test(clean)) return false;
	return clean.length % 4 !== 1;
}

function isSafeSubUrl(u) {
	if (typeof u !== 'string') return false;
	if (u.includes('|') || /[\r\n]/.test(u)) return false;
	try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

function isAllowedSubHost(hostname, allowList) {
	if (!allowList || allowList.length === 0) return true;
	const h = String(hostname).toLowerCase();
	return allowList.some(d => h === d || h.endsWith('.' + d));
}

function safeHost(u) {
	try { return new URL(u).hostname || 'unknown'; } catch { return 'unknown'; }
}

function redactSearch(search) {
	if (!search) return '';
	const params = new URLSearchParams(search);
	for (const key of ['token', 'key', 'b64', 'text', 'url', 'config']) {
		if (params.has(key)) params.set(key, '***');
	}
	const s = params.toString();
	return s ? '?' + s : '';
}

async function sendMessage(BotToken, ChatID, type, ip, add_data = "") {
	if (!BotToken || !ChatID) return;
	let msg = "";
	const ipCtl = new AbortController();
	const ipT = setTimeout(() => ipCtl.abort(), 3000);
	try {
		const response = await fetch(`https://ipapi.co/${ip}/json/`, { headers: { 'User-Agent': 'curl/8.0' }, signal: ipCtl.signal });
		if (response.ok) {
			const ipInfo = await response.json();
			msg = `${type}\nIP: ${ip}\n国家: ${ipInfo.country_name || ''}\n<tg-spoiler>城市: ${ipInfo.city || ''}\n组织: ${ipInfo.org || ''}\nASN: ${ipInfo.asn || ''}\n${add_data}`;
		} else {
			msg = `${type}\nIP: ${ip}\n<tg-spoiler>${add_data}`;
		}
	} catch { msg = `${type}\nIP: ${ip}\n<tg-spoiler>${add_data}`; }
	finally { clearTimeout(ipT); }
	const url = "https://api.telegram.org/bot" + BotToken + "/sendMessage?chat_id=" + ChatID + "&parse_mode=HTML&text=" + encodeURIComponent(msg);
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), 5000);
	try {
		return await fetch(url, {
			method: 'get',
			headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Mozilla/5.0 Chrome/90.0.4430.72' },
			signal: controller.signal,
		});
	} catch (e) {
		console.warn('Telegram 通知异常:', e.message);
	} finally { clearTimeout(t); }
}

async function nginx() {
	return `<!DOCTYPE html><html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1></body></html>`;
}
