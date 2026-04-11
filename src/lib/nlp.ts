/**
 * NLP utilities: n-gram extraction, stopword filtering, TF-IDF scoring.
 */

const STOPWORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'from','that','this','it','as','be','by','not','is','are','was','were',
    'have','has','had','do','did','will','would','could','should','my','your',
    'his','her','our','their','we','you','he','she','they','i','me','him',
    'us','them','what','which','who','how','when','where','why','about','into',
    'through','during','before','after','above','below','between','out','off',
    'over','under','then','just','so','up','if','no','can','also','get','got',
    'make','made','more','some','than','its','all','been','being','s','re',
]);

/**
 * Tokenise a string into lowercase alpha words, excluding stopwords.
 */
export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Extract n-grams (bigrams + trigrams by default) from a token list.
 */
export function extractNgrams(tokens: string[], ns: number[] = [1, 2, 3]): string[] {
    const ngrams: string[] = [];
    for (const n of ns) {
        for (let i = 0; i <= tokens.length - n; i++) {
            ngrams.push(tokens.slice(i, i + n).join(' '));
        }
    }
    return ngrams;
}

/**
 * Count phrase frequencies in a document.
 */
export function termFrequency(phrases: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of phrases) {
        counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return counts;
}

/**
 * Compute TF-IDF scores across a corpus of documents.
 * Returns a map: phrase -> { tf, idf, tfidf } per document index.
 */
export interface TfIdfScore {
    phrase: string;
    /** Raw frequency across the whole corpus */
    corpusCount: number;
    /** Number of documents the phrase appears in */
    docFreq: number;
    /** IDF = log(N / df) */
    idf: number;
    /** Average TF-IDF across documents that contain the phrase */
    avgTfIdf: number;
}

export function computeCorpusTfIdf(documents: string[][]): Map<string, TfIdfScore> {
    const N = documents.length;
    // phrase -> list of TF values per doc
    const dfMap = new Map<string, number>();
    const tfSums = new Map<string, number>();
    const corpusCounts = new Map<string, number>();

    for (const doc of documents) {
        const tf = termFrequency(doc);
        const docLen = doc.length || 1;
        const seen = new Set<string>();
        for (const [phrase, count] of tf) {
            corpusCounts.set(phrase, (corpusCounts.get(phrase) ?? 0) + count);
            const tfVal = count / docLen;
            tfSums.set(phrase, (tfSums.get(phrase) ?? 0) + tfVal);
            if (!seen.has(phrase)) {
                dfMap.set(phrase, (dfMap.get(phrase) ?? 0) + 1);
                seen.add(phrase);
            }
        }
    }

    const result = new Map<string, TfIdfScore>();
    for (const [phrase, df] of dfMap) {
        const idf = Math.log((N + 1) / (df + 1)) + 1; // smoothed
        const avgTf = (tfSums.get(phrase) ?? 0) / df;
        result.set(phrase, {
            phrase,
            corpusCount: corpusCounts.get(phrase) ?? 0,
            docFreq: df,
            idf,
            avgTfIdf: avgTf * idf,
        });
    }
    return result;
}

/**
 * Build phrase co-occurrence counts across documents.
 * Returns a map: "phraseA|||phraseB" -> co-occurrence count
 */
export function buildCoOccurrence(
    documents: string[][],
    topPhrases: Set<string>,
): Map<string, number> {
    const cooc = new Map<string, number>();
    for (const doc of documents) {
        const present = [...new Set(doc)].filter(p => topPhrases.has(p));
        for (let i = 0; i < present.length; i++) {
            for (let j = i + 1; j < present.length; j++) {
                const key = [present[i], present[j]].sort().join('|||');
                cooc.set(key, (cooc.get(key) ?? 0) + 1);
            }
        }
    }
    return cooc;
}
