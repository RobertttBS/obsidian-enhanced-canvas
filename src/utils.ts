/**
 * Compares version numbers.
 * Returns true if currentVersion > oldVersion.
 */
export function isVersionNewer(currentVersion: string, oldVersion: string): boolean {
    if (!currentVersion || !oldVersion) return false;
    if (currentVersion === oldVersion) return false;

    // Split "1.2.3" into [1, 2, 3]
    const current = currentVersion.split('.').map(Number);
    const old = oldVersion.split('.').map(Number);

    // Compare bit by bit
    for (let i = 0; i < 3; i++) {
        const v1 = current[i] || 0;
        const v2 = old[i] || 0;
        
        if (v1 > v2) return true;
        if (v1 < v2) return false;
    }
    
    return false; // Versions are the same
}
