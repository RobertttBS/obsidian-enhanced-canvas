import { TFile, MetadataCache, getAllTags, CachedMetadata } from "obsidian";

/**
 * Compares version numbers.
 * Returns true if currentVersion > oldVersion.
 */
export function isVersionNewer(currentVersion: string, oldVersion: string): boolean {
    if (!currentVersion || !oldVersion) return false;
    if (currentVersion === oldVersion) return false;

    // Split "1.2.3" into [1, 2, 3]
    const current = currentVersion.split('-')[0].split('.').map(Number);
    const old = oldVersion.split('-')[0].split('.').map(Number);

    // Compare bit by bit
    for (let i = 0; i < 3; i++) {
        const v1 = current[i] || 0;
        const v2 = old[i] || 0;
        
        if (v1 > v2) return true;
        if (v1 < v2) return false;
    }
    
    return false; // Versions are the same
}

/**
 * Generates a cryptographically secure random ID.
 */
export function randomId(length = 16): string {
    const byteLength = Math.ceil(length / 2);
    const array = new Uint8Array(byteLength);
    
    window.crypto.getRandomValues(array);
    
    return Array.from(array, (byte) => 
        byte.toString(16).padStart(2, '0')
    ).join('').substring(0, length);
}

export interface TagGroup {
    include: string[];
    exclude: string[];
}

export type TagQuery = TagGroup[];

export class TagQueryParser {
    /**
     * Parses a query string into a TagQuery structure.
     * Example: "#a #b -#c OR #d" -> [ {include: ["#a", "#b"], exclude: ["#c"]}, {include: ["#d"], exclude: []} ]
     */
    static parse(input: string): TagQuery {
        if (!input.trim()) return [];

        // Split by OR or | (case-insensitive)
        const groups = input.split(/(?:\s+|^)OR(?:\s+|$)|\|/i);
        const query: TagQuery = [];

        for (const groupStr of groups) {
            const trimmedGroup = groupStr.trim();
            if (!trimmedGroup) continue;

            // Split by whitespace first
            const whitespaceTokens = trimmedGroup.split(/\s+/);
            const group: TagGroup = { include: [], exclude: [] };

            for (let wToken of whitespaceTokens) {
                if (!wToken) continue;
                
                // Ignore explicit "AND" to gracefully handle user typos
                if (wToken.toUpperCase() === "AND") continue;

                let isExclude = false;
                if (wToken.startsWith("-")) {
                    isExclude = true;
                    wToken = wToken.substring(1);
                }

                // Split by '#' to handle concatenated tags like #tag1#tag2
                const tagTokens = wToken.split("#");
                for (const tagToken of tagTokens) {
                    if (!tagToken) continue;

                    // Normalize to lowercase and strip trailing punctuation (e.g., commas)
                    const tag = tagToken.toLowerCase().replace(/[,;]+$/, "");
                    
                    if (!tag) continue;

                    if (isExclude) {
                        group.exclude.push(tag);
                    } else {
                        group.include.push(tag);
                    }
                }
            }

            if (group.include.length > 0) {
                query.push(group);
            }
        }

        return query;
    }
}

export class TagLogicResolver {
    /**
     * Matches a file against a TagQuery.
     */
    static matchesQuery(file: TFile, query: TagQuery, metadataCache: MetadataCache): boolean {
        if (query.length === 0) return false;

        const cache = metadataCache.getFileCache(file);
        if (!cache) return false;

        const fileTags = this.getRobustFileTags(cache);

        // Match if ANY group matches (OR logic)
        return query.some(group => this.matchesGroup(fileTags, group));
    }

    /**
     * More robust version of getAllTags that handles various frontmatter formats.
     */
    private static getRobustFileTags(cache: CachedMetadata): string[] {
        const tags = [...(getAllTags(cache) || [])];
        
        // Manual extraction from frontmatter as fallback/supplement
        if (cache.frontmatter) {
            const fmTags = cache.frontmatter.tags || cache.frontmatter.tag;
            if (fmTags) {
                if (Array.isArray(fmTags)) {
                    fmTags.forEach(t => { if (typeof t === "string") tags.push(t); });
                } else if (typeof fmTags === "string") {
                    // Handle space or comma separated strings
                    tags.push(...fmTags.split(/[\s,]+/));
                }
            }
        }
        
        return tags;
    }

    private static matchesGroup(fileTags: string[], group: TagGroup): boolean {
        // Safety: ensure we have something to include
        if (group.include.length === 0) return false;

        // Pre-normalize file tags for efficiency (lowercase and strip # prefix)
        const normalizedFileTags = fileTags.map(t => (t.startsWith("#") ? t.substring(1) : t).toLowerCase());

        // All include tags must be present (or their children)
        const allIncluded = group.include.every(qTag => 
            normalizedFileTags.some(fTag => fTag === qTag || fTag.startsWith(`${qTag}/`))
        );

        if (!allIncluded) return false;

        // None of the exclude tags must be present (or their children)
        const anyExcluded = group.exclude.some(qTag => 
            normalizedFileTags.some(fTag => fTag === qTag || fTag.startsWith(`${qTag}/`))
        );

        return !anyExcluded;
    }
}
