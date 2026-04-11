/**
 * JellyJelly API Client
 * 
 * Documentation: https://jellyjelly.com/firehose
 */

export interface JellyParticipant {
    id: string;
    username: string;
    full_name: string;
    pfp_url: string | null;
}

export interface Jelly {
    id: string;
    started_by_id: string;
    participants: JellyParticipant[];
    title: string;
    thumbnail_url: string;
    posted_at: string;
    // Additional fields for full view
    access?: string;
    summary?: string | null;
    privacy?: string;
    video?: {
        original_duration: number;
        hls_master: string | null;
        mp4_fallback: string | null;
    };
    likes_count?: number | null;
    comments_count?: number | null;
    all_views?: number | null;
}

export interface SearchParams {
    q?: string;
    username?: string;
    start_date?: string;
    end_date?: string;
    sort_by?: 'date' | 'likes' | 'views';
    ascending?: boolean;
    page?: number;
    page_size?: number;
}

export interface SearchResponse {
    status: string;
    total: number;
    page: number;
    page_size: number;
    jellies: Jelly[];
}

export class JellyClient {
    private baseUrl = 'https://api.jellyjelly.com/v3/jelly';

    /**
     * Searches public jellies by title, summary, and username.
     */
    async search(params: SearchParams = {}): Promise<SearchResponse> {
        const query = new URLSearchParams();
        if (params.q) query.append('q', params.q);
        if (params.username) query.append('username', params.username);
        if (params.start_date) query.append('start_date', params.start_date);
        if (params.end_date) query.append('end_date', params.end_date);
        if (params.sort_by) query.append('sort_by', params.sort_by);
        if (params.ascending !== undefined) query.append('ascending', String(params.ascending));
        if (params.page !== undefined) query.append('page', String(params.page));
        if (params.page_size !== undefined) query.append('page_size', String(params.page_size));

        const res = await fetch(`${this.baseUrl}/search?${query.toString()}`);
        if (!res.ok) {
            const error = await res.text();
            throw new Error(`JellyJelly Search API Error: ${res.status} ${error}`);
        }

        return await res.json() as SearchResponse;
    }

    /**
     * Retrieves full details for a specific jelly.
     */
    async getById(id: string): Promise<Jelly> {
        const res = await fetch(`${this.baseUrl}/${id}`);
        if (!res.ok) {
            const error = await res.text();
            throw new Error(`JellyJelly Get API Error: ${res.status} ${error}`);
        }

        const data = await res.json() as { status: string; jelly: Jelly };
        return data.jelly;
    }
}
