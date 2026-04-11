/**
 * Boostr — writes the topic graph into Neo4j using batched UNWIND queries.
 *
 * Node labels:   Creator, Jelly, Phrase
 * Relationships: POSTED, MENTIONS (weight), CO_OCCURS_WITH (weight)
 */

import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type { Jelly } from './jelly.js';
import type { JellyScore, PhraseScore } from './scorer.js';

export function createDriver(uri: string, user: string, password: string): Driver {
    return neo4j.driver(uri, neo4j.auth.basic(user, password), {
        connectionTimeout: 15_000,
        maxConnectionLifetime: 60_000,
    });
}

async function run(session: Session, cypher: string, params: Record<string, unknown> = {}) {
    return session.run(cypher, params);
}

export async function clearGraph(session: Session) {
    await run(session, 'MATCH (n) DETACH DELETE n');
}

export async function writeGraph(
    session: Session,
    jellies: Jelly[],
    jellyScores: Map<string, JellyScore>,
    phraseScores: PhraseScore[],
    phraseToJellies: Map<string, string[]>,
    jellyToPhrases: Map<string, string[]>,
    coOccurrence: Map<string, number>,
) {
    // ── Creators ────────────────────────────────────────────────────────────
    console.log('  Writing Creator nodes...');
    const creatorRows = jellies.map(j => {
        const c = j.participants[0];
        return {
            id: c?.id ?? j.started_by_id,
            username: c?.username ?? 'unknown',
            fullName: c?.full_name ?? '',
            pfpUrl: c?.pfp_url ?? '',
        };
    });
    await run(session, `
        UNWIND $rows AS row
        MERGE (c:Creator {id: row.id})
        SET c.username = row.username,
            c.full_name = row.fullName,
            c.pfp_url = row.pfpUrl
    `, { rows: creatorRows });

    // ── Jellies ──────────────────────────────────────────────────────────────
    console.log('  Writing Jelly nodes...');
    const jellyRows = jellies.map(j => {
        const s = jellyScores.get(j.id);
        return {
            id: j.id,
            title: j.title,
            postedAt: j.posted_at,
            views: s?.views ?? 0,
            likes: j.likes_count ?? 0,
            comments: j.comments_count ?? 0,
            success: s?.success ?? 0,
            velocity: s?.velocity ?? 0,
            thumbnail: j.thumbnail_url ?? '',
            creatorId: j.participants[0]?.id ?? j.started_by_id,
        };
    });
    await run(session, `
        UNWIND $rows AS row
        MERGE (j:Jelly {id: row.id})
        SET j.title     = row.title,
            j.postedAt  = row.postedAt,
            j.views     = row.views,
            j.likes     = row.likes,
            j.comments  = row.comments,
            j.success   = row.success,
            j.velocity  = row.velocity,
            j.thumbnail = row.thumbnail
    `, { rows: jellyRows });

    // ── POSTED edges ─────────────────────────────────────────────────────────
    console.log('  Writing POSTED edges...');
    await run(session, `
        UNWIND $rows AS row
        MATCH (c:Creator {id: row.creatorId}), (j:Jelly {id: row.id})
        MERGE (c)-[:POSTED]->(j)
    `, { rows: jellyRows });

    // ── Phrases ──────────────────────────────────────────────────────────────
    console.log('  Writing Phrase nodes...');
    const phraseRows = phraseScores.map(ps => ({
        text: ps.phrase,
        jellyCount: ps.jellyCount,
        avgSuccess: ps.avgSuccess,
        weightedScore: ps.weightedSuccess,
        momentum: ps.momentum,
        avgHoursOld: ps.avgHoursOld,
        momentumScore:  ps.momentumScore,
        decayRisk:      ps.decayRisk,
        opportunityFit: ps.opportunityFit,
        actionPriority: ps.actionPriority,
        action:         ps.action,
    }));
    // Batch in chunks of 500 to stay under Neo4j param limits
    for (let i = 0; i < phraseRows.length; i += 500) {
        await run(session, `
            UNWIND $rows AS row
            MERGE (p:Phrase {text: row.text})
            SET p.jellyCount     = row.jellyCount,
                p.avgSuccess     = row.avgSuccess,
                p.weightedScore  = row.weightedScore,
                p.momentum       = row.momentum,
                p.avgHoursOld    = row.avgHoursOld,
                p.momentumScore  = row.momentumScore,
                p.decayRisk      = row.decayRisk,
                p.opportunityFit = row.opportunityFit,
                p.actionPriority = row.actionPriority,
                p.action         = row.action
        `, { rows: phraseRows.slice(i, i + 500) });
    }

    // ── MENTIONS edges ───────────────────────────────────────────────────────
    console.log('  Writing MENTIONS edges...');
    const mentionsRows: { jellyId: string; phrase: string; weight: number }[] = [];
    for (const ps of phraseScores) {
        for (const jellyId of phraseToJellies.get(ps.phrase) ?? []) {
            const count = (jellyToPhrases.get(jellyId) ?? []).filter(p => p === ps.phrase).length;
            mentionsRows.push({ jellyId, phrase: ps.phrase, weight: count });
        }
    }
    for (let i = 0; i < mentionsRows.length; i += 500) {
        await run(session, `
            UNWIND $rows AS row
            MATCH (j:Jelly {id: row.jellyId}), (p:Phrase {text: row.phrase})
            MERGE (j)-[r:MENTIONS]->(p)
            SET r.weight = row.weight
        `, { rows: mentionsRows.slice(i, i + 500) });
    }

    // ── CO_OCCURS_WITH edges ─────────────────────────────────────────────────
    console.log('  Writing CO_OCCURS_WITH edges...');
    const phraseSet = new Set(phraseScores.map(p => p.phrase));
    const coocRows = [...coOccurrence.entries()]
        .map(([key, count]) => {
            const [a, b] = key.split('|||');
            return { a, b, weight: count };
        })
        .filter(r => phraseSet.has(r.a) && phraseSet.has(r.b));

    for (let i = 0; i < coocRows.length; i += 500) {
        await run(session, `
            UNWIND $rows AS row
            MATCH (pa:Phrase {text: row.a}), (pb:Phrase {text: row.b})
            MERGE (pa)-[r:CO_OCCURS_WITH]->(pb)
            SET r.weight = row.weight
        `, { rows: coocRows.slice(i, i + 500) });
    }

    console.log(`  Graph written: ${jellyRows.length} jellies, ${phraseRows.length} phrases, ${coocRows.length} co-occurrence edges.`);
}

export async function queryTopPhrases(
    session: Session,
    limit = 10,
    momentum?: 'rising' | 'stable' | 'decaying',
) {
    const filter = momentum ? 'WHERE p.momentum = $momentum' : '';
    const result = await run(session, `
        MATCH (p:Phrase)
        ${filter}
        RETURN p.text AS phrase,
               p.momentum AS momentum,
               p.weightedScore AS score,
               p.jellyCount AS jellyCount,
               p.avgHoursOld AS avgHoursOld,
               p.momentumScore AS momentumScore,
               p.decayRisk AS decayRisk,
               p.opportunityFit AS opportunityFit,
               p.actionPriority AS actionPriority,
               p.action AS action
        ORDER BY p.weightedScore DESC
        LIMIT $limit
    `, { limit: neo4j.int(limit), momentum: momentum ?? null });

    return result.records.map(r => ({
        phrase:         r.get('phrase') as string,
        momentum:       r.get('momentum') as string,
        score:          (r.get('score') as number | null) ?? 0,
        jellyCount:     (r.get('jellyCount') as number | null) ?? 0,
        avgHoursOld:    (r.get('avgHoursOld') as number | null) ?? 0,
        momentumScore:  (r.get('momentumScore') as number | null) ?? 0,
        decayRisk:      (r.get('decayRisk') as number | null) ?? 0,
        opportunityFit: (r.get('opportunityFit') as number | null) ?? 0,
        actionPriority: (r.get('actionPriority') as number | null) ?? 0,
        action:         (r.get('action') as string | null) ?? 'remix',
    }));
}

export async function queryNeighbors(session: Session, phrase: string, limit = 5) {
    const result = await run(session, `
        MATCH (p:Phrase {text: $phrase})-[r:CO_OCCURS_WITH]-(neighbor:Phrase)
        RETURN neighbor.text AS phrase,
               neighbor.momentum AS momentum,
               neighbor.weightedScore AS score,
               r.weight AS coWeight
        ORDER BY r.weight DESC, neighbor.weightedScore DESC
        LIMIT $limit
    `, { phrase, limit: neo4j.int(limit) });

    return result.records.map(r => ({
        phrase: r.get('phrase') as string,
        momentum: r.get('momentum') as string,
        score: (r.get('score') as number | null) ?? 0,
        coWeight: (r.get('coWeight') as number | null) ?? 0,
    }));
}
