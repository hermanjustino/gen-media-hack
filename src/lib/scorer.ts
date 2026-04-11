/**
 * Boostr — Momentum Engine
 *
 * MomentumScore = 0.35(Velocity) + 0.25(EngagementRate) + 0.20(ContributorGrowth)
 *               + 0.10(RecencyBoost) + 0.10(TopicSpread)
 *
 * ActionPriority = MomentumScore × DecayRisk × OpportunityFit
 */

import type { Jelly } from './jelly.js';

export interface JellyScore {
    jellyId: string;
    views: number;
    likes: number;
    comments: number;
    engagementRate: number;
    velocity: number;          // views/hour (falls back to likes/hour if no views)
    recencyBoost: number;      // exp(-hoursOld / 24) — 1.0 = brand new, ~0 = stale
    participantCount: number;  // proxy for contributor growth
    hoursOld: number;
    success: number;           // legacy score kept for Jelly node ordering in Neo4j
}

export type MomentumLabel = 'rising' | 'stable' | 'decaying';
export type ActionLabel   = 'double_down' | 'collaborate' | 'remix' | 'retire';

export const ACTION_LABEL: Record<ActionLabel, string> = {
    double_down: 'Double Down Now',
    collaborate: 'Collaborate Injection',
    remix:       'Remix / Clip Refresh',
    retire:      'Retire Topic',
};

export interface PhraseScore {
    phrase: string;
    jellyCount: number;

    // Normalised component scores (0–1 each, after log-scale min-max across corpus)
    compVelocity: number;
    compEngagement: number;
    compContributorGrowth: number;
    compRecencyBoost: number;
    compTopicSpread: number;

    // Momentum Engine outputs
    momentumScore: number;    // weighted sum of components
    decayRisk: number;        // 0–1  (1.0 = velocity dropping fast)
    opportunityFit: number;   // 0–1  (engagement quality × topic breadth)
    actionPriority: number;   // momentumScore × decayRisk × opportunityFit

    momentum: MomentumLabel;
    action: ActionLabel;

    // Backward-compat fields used by neo4j_graph.ts
    avgSuccess: number;       // = momentumScore
    maxSuccess: number;
    weightedSuccess: number;  // = momentumScore × tfidf weight
    avgHoursOld: number;
}

// ── Per-jelly scoring ─────────────────────────────────────────────────────────

export function scoreJelly(jelly: Jelly): JellyScore {
    const views    = jelly.all_views      ?? 0;
    const likes    = jelly.likes_count    ?? 0;
    const comments = jelly.comments_count ?? 0;

    const hoursOld = Math.max(
        (Date.now() - new Date(jelly.posted_at).getTime()) / 3_600_000,
        0.1,
    );

    const engagementRate   = (likes + comments) / Math.max(views, 1);
    const velocity         = views > 0 ? views / hoursOld : likes / hoursOld;
    const recencyBoost     = Math.exp(-hoursOld / 24);
    const participantCount = jelly.participants?.length ?? 1;

    // Legacy success score kept for Jelly node ordering in Neo4j queries
    const success =
        0.5 * Math.log(1 + views) +
        0.3 * engagementRate +
        0.2 * Math.log(1 + velocity);

    return {
        jellyId: jelly.id,
        views, likes, comments,
        engagementRate, velocity, recencyBoost, participantCount,
        hoursOld, success,
    };
}

// ── Phrase / cluster scoring ──────────────────────────────────────────────────

export function scorePhrases(
    phraseToJellies: Map<string, string[]>,
    jellyScores:     Map<string, JellyScore>,
    tfIdfWeight:     Map<string, number>,
    coOccurrence:    Map<string, number>,   // "phraseA|||phraseB" → count
): PhraseScore[] {
    // TopicSpread: count of distinct co-occurring phrase partners per phrase
    const topicSpreadMap = new Map<string, number>();
    for (const key of coOccurrence.keys()) {
        const sep = key.indexOf('|||');
        const a   = key.slice(0, sep);
        const b   = key.slice(sep + 3);
        topicSpreadMap.set(a, (topicSpreadMap.get(a) ?? 0) + 1);
        topicSpreadMap.set(b, (topicSpreadMap.get(b) ?? 0) + 1);
    }

    // ── Pass 1: raw component values ──────────────────────────────────────────
    interface Raw {
        phrase: string;
        jellyCount: number;
        rawVelocity: number;
        rawEngagement: number;
        rawContributorGrowth: number;  // unique participants in last 24h
        rawRecencyBoost: number;
        rawTopicSpread: number;
        maxSuccess: number;
        avgHoursOld: number;
        // Posting-rate comparison: jellies-per-hour now vs historically.
        // We compare creation rate rather than view velocity because viral old
        // jellies have huge lifetime view counts that drown out fresh content.
        recentRate: number;  // jellies posted in last 24h / 24
        olderRate: number;   // jellies posted ≥ 24h ago / hours spanned by that window
    }

    const raw: Raw[] = [];

    for (const [phrase, jellyIds] of phraseToJellies) {
        if (jellyIds.length === 0) continue;
        const scores = jellyIds
            .map(id => jellyScores.get(id))
            .filter((s): s is JellyScore => s !== undefined);
        if (scores.length === 0) continue;

        const recent = scores.filter(j => j.hoursOld < 24);
        const older  = scores.filter(j => j.hoursOld >= 24);

        // Older window spans from 24h ago back to the oldest jelly in this cluster
        const maxOlderHours = older.length
            ? Math.max(...older.map(j => j.hoursOld))
            : 0;
        const olderWindowHours = Math.max(maxOlderHours - 24, 24);
        const recentRate = recent.length / 24;
        const olderRate  = older.length  / olderWindowHours;

        raw.push({
            phrase,
            jellyCount: jellyIds.length,
            rawVelocity:          scores.reduce((s, j) => s + j.velocity, 0) / scores.length,
            rawEngagement:        scores.reduce((s, j) => s + j.engagementRate, 0) / scores.length,
            rawContributorGrowth: recent.reduce((s, j) => s + j.participantCount, 0),
            rawRecencyBoost:      scores.reduce((s, j) => s + j.recencyBoost, 0) / scores.length,
            rawTopicSpread:       topicSpreadMap.get(phrase) ?? 0,
            maxSuccess:           Math.max(...scores.map(j => j.success)),
            avgHoursOld:          scores.reduce((s, j) => s + j.hoursOld, 0) / scores.length,
            recentRate,
            olderRate,
        });
    }

    if (raw.length === 0) return [];

    // ── Pass 2: normalise each component to [0, 1] across the corpus ─────────
    function logMinMax(vals: number[]): number[] {
        const logged = vals.map(v => Math.log(1 + v));
        const min = Math.min(...logged);
        const max = Math.max(...logged);
        const range = max - min || 1;
        return logged.map(v => (v - min) / range);
    }
    function minMaxNorm(vals: number[]): number[] {
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const range = max - min || 1;
        return vals.map(v => (v - min) / range);
    }

    const normVelocity    = logMinMax(raw.map(r => r.rawVelocity));
    const normEngagement  = minMaxNorm(raw.map(r => r.rawEngagement));
    const normContributor = logMinMax(raw.map(r => r.rawContributorGrowth));
    const normRecency     = minMaxNorm(raw.map(r => r.rawRecencyBoost));
    const normTopicSpread = logMinMax(raw.map(r => r.rawTopicSpread));

    // ── Pass 3: MomentumScore + ActionPriority ────────────────────────────────
    const results: PhraseScore[] = [];

    for (let i = 0; i < raw.length; i++) {
        const r = raw[i];

        const compVelocity          = normVelocity[i];
        const compEngagement        = normEngagement[i];
        const compContributorGrowth = normContributor[i];
        const compRecencyBoost      = normRecency[i];
        const compTopicSpread       = normTopicSpread[i];

        const momentumScore =
            0.35 * compVelocity +
            0.25 * compEngagement +
            0.20 * compContributorGrowth +
            0.10 * compRecencyBoost +
            0.10 * compTopicSpread;

        // DecayRisk: 1.0 = posting rate dropping fast, 0.0 = holding or rising
        const rr = r.recentRate;
        const or = r.olderRate;
        let decayRisk: number;
        if (rr === 0 && or === 0) {
            decayRisk = 0.5;
        } else if (or === 0) {
            decayRisk = 0.1;  // all content is fresh — no historical baseline to decay from
        } else {
            // ratio < 1 means fewer posts recently; map [0.5 … 2.0] → [1.0 … 0.0]
            decayRisk = Math.max(0, Math.min(1, 1 - (rr / or - 0.5) / 1.5));
        }

        // OpportunityFit: how well this topic plays to the audience
        const opportunityFit = 0.6 * compEngagement + 0.4 * compTopicSpread;

        const actionPriority = momentumScore * decayRisk * opportunityFit;

        // Momentum label — based on posting-rate trend, not view velocity
        let momentum: MomentumLabel;
        if (or === 0 ? rr > 0 : rr > or * 1.2) {
            momentum = 'rising';
        } else if (or > 0 && rr < or * 0.8) {
            momentum = 'decaying';
        } else {
            momentum = 'stable';
        }

        // Action label — first matching rule wins
        let action: ActionLabel;
        if (momentumScore < 0.25 || (momentumScore < 0.4 && opportunityFit < 0.25)) {
            action = 'retire';
        } else if (momentumScore >= 0.6 && decayRisk <= 0.35) {
            action = 'double_down';
        } else if (momentumScore >= 0.5 && decayRisk <= 0.65) {
            action = 'collaborate';
        } else {
            action = 'remix';
        }

        const tfidf         = tfIdfWeight.get(r.phrase) ?? 1;
        const weightedSuccess = momentumScore * tfidf;

        results.push({
            phrase: r.phrase,
            jellyCount: r.jellyCount,
            compVelocity, compEngagement, compContributorGrowth, compRecencyBoost, compTopicSpread,
            momentumScore, decayRisk, opportunityFit, actionPriority,
            momentum, action,
            avgSuccess:     momentumScore,
            maxSuccess:     r.maxSuccess,
            weightedSuccess,
            avgHoursOld:    r.avgHoursOld,
        });
    }

    return results.sort((a, b) => b.momentumScore - a.momentumScore);
}
