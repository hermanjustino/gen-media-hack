/**
 * Tavus API client for Knowledge Base documents and conversations.
 * Docs: https://docs.tavus.io/api-reference
 */

const TAVUS_BASE_URL = 'https://tavusapi.com/v2';

export interface TavusDocument {
    document_id: string;
    document_name: string;
    document_url: string;
    status: 'started' | 'processing' | 'ready' | 'error' | 'recrawling';
    progress: number | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    callback_url?: string;
    tags?: string[];
}

export interface TavusCreateDocumentRequest {
    document_url: string;
    document_name?: string;
    callback_url?: string;
    tags?: string[];
    crawl?: {
        depth?: number;
        max_pages?: number;
    };
}

export interface TavusCreateConversationRequest {
    replica_id?: string;
    persona_id: string;
    audio_only?: boolean;
    callback_url?: string;
    conversation_name?: string;
    conversational_context?: string;
    custom_greeting?: string;
    memory_stores?: string[];
    document_ids?: string[];
    document_retrieval_strategy?: 'speed' | 'quality' | 'balanced';
    document_tags?: string[];
    test_mode?: boolean;
    require_auth?: boolean;
    max_participants?: number;
}

export interface TavusConversation {
    conversation_id: string;
    conversation_name?: string;
    conversation_url: string;
    status: 'active' | 'ended';
    callback_url?: string;
    created_at: string;
    meeting_token?: string;
}

export interface TavusCreateVideoRequest {
    replica_id: string;
    script: string;
    video_name?: string;
    background_url?: string;
    background_source_url?: string;
    callback_url?: string;
    fast?: boolean;
}

export interface TavusVideo {
    video_id: string;
    video_name: string;
    status: 'queued' | 'generating' | 'ready' | 'deleted' | 'error';
    hosted_url: string;
    created_at: string;
}

export interface TavusPersona {
    persona_id: string;
    persona_name: string;
    default_replica_id?: string;
    document_ids?: string[];
    document_tags?: string[];
}

export interface TavusReplica {
    replica_id: string;
    replica_name: string;
    status: string;
    replica_type?: string;
}

async function tavusFetch<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${TAVUS_BASE_URL}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            ...(init?.headers ?? {}),
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Tavus API ${response.status}: ${text}`);
    }

    if (response.status === 204) {
        return {} as T;
    }
    return await response.json() as T;
}

export class TavusClient {
    constructor(private readonly apiKey: string) {}

    async createDocument(payload: TavusCreateDocumentRequest): Promise<TavusDocument> {
        return tavusFetch<TavusDocument>('/documents', this.apiKey, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    async getDocument(documentId: string): Promise<TavusDocument> {
        return tavusFetch<TavusDocument>(`/documents/${encodeURIComponent(documentId)}`, this.apiKey);
    }

    async listDocuments(): Promise<{ data: TavusDocument[]; total_count: number; page?: number; limit?: number }> {
        return tavusFetch<{ data: TavusDocument[]; total_count: number; page?: number; limit?: number }>(
            '/documents',
            this.apiKey,
        );
    }

    async createConversation(payload: TavusCreateConversationRequest): Promise<TavusConversation> {
        return tavusFetch<TavusConversation>('/conversations', this.apiKey, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    async createVideo(payload: TavusCreateVideoRequest): Promise<TavusVideo> {
        return tavusFetch<TavusVideo>('/videos', this.apiKey, {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    async getVideo(videoId: string): Promise<TavusVideo> {
        return tavusFetch<TavusVideo>(`/videos/${encodeURIComponent(videoId)}`, this.apiKey);
    }

    async listPersonas(): Promise<{ data: TavusPersona[]; total_count?: number }> {
        return tavusFetch<{ data: TavusPersona[]; total_count?: number }>('/personas', this.apiKey);
    }

    async listReplicas(): Promise<{ data: TavusReplica[]; total_count?: number }> {
        return tavusFetch<{ data: TavusReplica[]; total_count?: number }>('/replicas', this.apiKey);
    }
}
