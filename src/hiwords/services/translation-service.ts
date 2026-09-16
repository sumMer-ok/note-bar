import { requestUrl } from 'obsidian';
import type { AIProvider, HiWordsSettings } from '../utils';

type JsonObject = Record<string, unknown>;
type JsonPath = Array<string | number>;

function readStringPath(data: unknown, path: JsonPath): string | undefined {
    let current = data;
    for (const segment of path) {
        if (typeof segment === 'number') {
            if (!Array.isArray(current)) return undefined;
            current = current[segment];
            continue;
        }
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === 'string' ? current : undefined;
}

interface CacheEntry {
    content: string;
    timestamp: number;
}

export class TranslationService {
    private settings: HiWordsSettings;
    private cache = new Map<string, CacheEntry>();
    private readonly CACHE_TTL = 30 * 60 * 1000;
    private abortController: AbortController | null = null;

    constructor(settings: HiWordsSettings) {
        this.settings = settings;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
    }

    async translate(text: string): Promise<string> {
        if (!text?.trim()) {
            throw new Error('翻译文本不能为空');
        }
        const cleanText = text.trim();
        const cacheKey = `ai:${cleanText}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.content;
        }
        const result = await this.translateWithAI(cleanText);
        this.cache.set(cacheKey, { content: result, timestamp: Date.now() });
        return result;
    }

    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    private async translateWithAI(text: string): Promise<string> {
        const aiConfig = this.settings.aiService;
        if (!aiConfig?.apiUrl || !aiConfig?.apiKey || !aiConfig?.model) {
            throw new Error('AI 翻译未配置，请在设置中填写 API 信息');
        }
        const targetLang = this.settings.selectionTranslate.targetLang || 'zh-CN';
        const promptTemplate = this.settings.selectionTranslate.prompt ||
            'Translate the following text to {{to}}. Only return the translation, no explanation.\n\nText: {{text}}';
        const prompt = promptTemplate
            .replace(/\{\{text\}\}/g, text)
            .replace(/\{\{to\}\}/g, targetLang);
        const url = aiConfig.apiUrl;
        const apiType = this.detectAPIType(url, aiConfig.provider);
        let requestBody: JsonObject;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        let finalUrl = url;

        switch (apiType) {
            case 'claude':
                requestBody = {
                    model: aiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 1024
                };
                headers['x-api-key'] = aiConfig.apiKey;
                headers['anthropic-version'] = '2023-06-01';
                break;
            case 'gemini':
                requestBody = {
                    contents: [{ parts: [{ text: prompt }] }]
                };
                break;
            default:
                requestBody = {
                    model: aiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3,
                    max_tokens: 4096
                };
                headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
                break;
        }
        finalUrl = this.buildRequestUrl(finalUrl, aiConfig.model, aiConfig.apiKey, apiType);
        requestBody = this.mergeExtraParams(requestBody, aiConfig.extraParams);
        const response = await requestUrl({
            url: finalUrl,
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        });
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}: ${response.text}`);
        }
        const data = response.json as unknown;
        let content: string | undefined;
        switch (apiType) {
            case 'claude':
                content = readStringPath(data, ['content', 0, 'text']);
                break;
            case 'gemini':
                content = readStringPath(data, ['candidates', 0, 'content', 'parts', 0, 'text']);
                break;
            default:
                content = readStringPath(data, ['choices', 0, 'message', 'content']);
                break;
        }
        if (!content) {
            throw new Error('翻译服务返回了无效的响应');
        }
        let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (!cleaned) cleaned = content.trim();
        return cleaned;
    }

    private detectAPIType(url: string, provider: AIProvider): 'openai' | 'claude' | 'gemini' {
        if (provider !== 'custom') {
            const providerMap: Record<Exclude<AIProvider, 'custom'>, 'openai' | 'claude' | 'gemini'> = {
                'openai-compatible': 'openai',
                anthropic: 'claude',
                gemini: 'gemini'
            };
            return providerMap[provider];
        }
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('anthropic')) return 'claude';
        if (lowerUrl.includes('googleapis') || lowerUrl.includes('generativelanguage')) return 'gemini';
        return 'openai';
    }

    private buildRequestUrl(baseUrl: string, model: string, apiKey: string, apiType: 'openai' | 'claude' | 'gemini'): string {
        const normalized = baseUrl.replace(/\/$/, '');
        switch (apiType) {
            case 'claude':
                return normalized.endsWith('/messages') ? normalized : `${normalized}/v1/messages`;
            case 'gemini':
                if (normalized.includes(':generateContent')) {
                    return `${normalized}?key=${apiKey}`;
                }
                return `${normalized}/models/${model}:generateContent?key=${apiKey}`;
            case 'openai':
            default:
                return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
        }
    }

    private isObject(item: unknown): item is JsonObject {
        return !!item && typeof item === 'object' && !Array.isArray(item);
    }

    private deepMerge(target: JsonObject, source: JsonObject): JsonObject {
        const output = { ...target };
        if (this.isObject(target) && this.isObject(source)) {
            Object.keys(source).forEach(key => {
                const sourceValue = source[key];
                const targetValue = target[key];
                if (this.isObject(sourceValue)) {
                    output[key] = key in target && this.isObject(targetValue)
                        ? this.deepMerge(targetValue, sourceValue)
                        : sourceValue;
                } else {
                    output[key] = sourceValue;
                }
            });
        }
        return output;
    }

    private mergeExtraParams(baseBody: JsonObject, extraParamsJson?: string): JsonObject {
        const json = extraParamsJson?.trim();
        if (!json || json === '{}') return baseBody;
        try {
            const extraParams = JSON.parse(json) as unknown;
            if (!this.isObject(extraParams)) return baseBody;
            return this.deepMerge(baseBody, extraParams);
        } catch (error) {
            console.warn('Invalid JSON in extraParams, ignoring:', error);
            return baseBody;
        }
    }

    clearCache() {
        this.cache.clear();
    }
}
