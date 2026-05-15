import { requestUrl } from 'obsidian';
import type { AIProvider, AIServiceSettings } from '../utils';

type APIType = 'openai' | 'claude' | 'gemini';
type JsonObject = Record<string, unknown>;
type JsonPath = Array<string | number>;

interface AIConfig {
    service: AIServiceSettings;
    prompt: string;
}

interface APIAdapter {
    buildRequest: (model: string, prompt: string) => JsonObject;
    buildHeaders: (apiKey: string) => Record<string, string>;
    extractResponse: (data: unknown) => string | undefined;
    buildUrl?: (baseUrl: string, model: string, apiKey: string) => string;
}

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

export class DictionaryService {
    private config: AIConfig;
    private cache = new Map<string, CacheEntry>();
    private readonly CACHE_TTL = 24 * 60 * 60 * 1000;
    private readonly MAX_RETRIES = 3;

    private readonly API_ADAPTERS: Record<APIType, APIAdapter> = {
        openai: {
            buildRequest: (model: string, prompt: string) => ({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 500
            }),
            buildHeaders: (apiKey: string) => ({ 'Authorization': `Bearer ${apiKey}` }),
            extractResponse: (data: unknown) => readStringPath(data, ['choices', 0, 'message', 'content']),
            buildUrl: (baseUrl: string) => {
                const normalized = baseUrl.replace(/\/$/, '');
                return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
            }
        },
        claude: {
            buildRequest: (model: string, prompt: string) => ({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024
            }),
            buildHeaders: (apiKey: string) => ({
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            }),
            extractResponse: (data: unknown) => readStringPath(data, ['content', 0, 'text']),
            buildUrl: (baseUrl: string) => {
                const normalized = baseUrl.replace(/\/$/, '');
                return normalized.endsWith('/messages') ? normalized : `${normalized}/v1/messages`;
            }
        },
        gemini: {
            buildRequest: (_model: string, prompt: string) => ({
                contents: [{ parts: [{ text: prompt }] }]
            }),
            buildHeaders: () => ({}),
            extractResponse: (data: unknown) => readStringPath(data, ['candidates', 0, 'content', 'parts', 0, 'text']),
            buildUrl: (baseUrl: string, model: string, apiKey: string) => {
                let url = baseUrl;
                if (!url.includes(':generateContent')) {
                    url = `${url.replace(/\/$/, '')}/models/${model}:generateContent`;
                }
                return `${url}?key=${apiKey}`;
            }
        }
    };

    constructor(config: AIConfig) {
        this.config = config;
    }

    private detectAPIType(): APIType {
        if (this.config.service.provider !== 'custom') {
            const providerMap: Record<Exclude<AIProvider, 'custom'>, APIType> = {
                'openai-compatible': 'openai',
                anthropic: 'claude',
                gemini: 'gemini'
            };
            return providerMap[this.config.service.provider];
        }
        const url = this.config.service.apiUrl.toLowerCase();
        if (url.includes('anthropic')) return 'claude';
        if (url.includes('googleapis') || url.includes('generativelanguage')) return 'gemini';
        return 'openai';
    }

    private validateConfig(): { isValid: boolean; error?: string } {
        if (!this.config.service.apiUrl?.trim()) return { isValid: false, error: 'API 地址不能为空' };
        if (!this.config.service.apiKey?.trim()) return { isValid: false, error: 'API Key 未配置' };
        if (!this.config.service.model?.trim()) return { isValid: false, error: '模型 ID 不能为空' };
        if (!this.config.prompt?.trim()) return { isValid: false, error: '提示词不能为空' };
        try { new URL(this.config.service.apiUrl); } catch { return { isValid: false, error: 'API 地址格式无效' }; }
        if (!this.config.prompt.includes('{{word}}')) return { isValid: false, error: '提示词必须包含 {{word}} 占位符' };
        return { isValid: true };
    }

    private replacePlaceholders(word: string, sentence?: string): string {
        return this.config.prompt
            .replace(/\{\{word\}\}/g, word)
            .replace(/\{\{sentence\}\}/g, sentence || '');
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

    private mergeExtraParams(baseBody: JsonObject): JsonObject {
        const extraParamsJson = this.config.service.extraParams?.trim();
        if (!extraParamsJson || extraParamsJson === '{}' || extraParamsJson === '') return baseBody;
        try {
            const extraParams = JSON.parse(extraParamsJson) as unknown;
            if (!this.isObject(extraParams)) return baseBody;
            return this.deepMerge(baseBody, extraParams);
        } catch {
            return baseBody;
        }
    }

    async fetchDefinition(word: string, sentence?: string): Promise<string> {
        if (!word?.trim()) throw new Error('单词不能为空');
        const validation = this.validateConfig();
        if (!validation.isValid) throw new Error(validation.error ?? '请求失败');
        const cleanWord = word.trim();
        const cacheKey = `${cleanWord}:${sentence || ''}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) return cached.content;
        const apiType = this.detectAPIType();
        const adapter = this.API_ADAPTERS[apiType];
        const prompt = this.replacePlaceholders(cleanWord, sentence);
        const url = adapter.buildUrl
            ? adapter.buildUrl(this.config.service.apiUrl, this.config.service.model, this.config.service.apiKey)
            : this.config.service.apiUrl;
        const headers = adapter.buildHeaders(this.config.service.apiKey);
        let body = adapter.buildRequest(this.config.service.model, prompt);
        body = this.mergeExtraParams(body);
        const data = await this.makeRequestWithRetry(url, headers, body);
        const content = adapter.extractResponse(data);
        if (!content) throw new Error('API 返回了无效的响应格式');
        const result = content.trim();
        this.cache.set(cacheKey, { content: result, timestamp: Date.now() });
        return result;
    }

    private async makeRequestWithRetry(url: string, headers: Record<string, string>, body: JsonObject): Promise<unknown> {
        let lastError: unknown;
        for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
            try {
                const response = await requestUrl({
                    url,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...headers },
                    body: JSON.stringify(body)
                });
                if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${response.text}`);
                return response.json;
            } catch (error) {
                lastError = error;
                const errorMsg = String(error);
                if (errorMsg.includes('400') || errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('404')) break;
                if (attempt < this.MAX_RETRIES - 1) {
                    await new Promise(resolve => activeWindow.setTimeout(resolve, 1000 * Math.pow(2, attempt)));
                }
            }
        }
        throw lastError;
    }

    clearCache(): void {
        this.cache.clear();
    }
}
