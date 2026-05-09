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
export function randomId(length: number = 16): string {
    const byteLength = Math.ceil(length / 2);
    const array = new Uint8Array(byteLength);
    
    window.crypto.getRandomValues(array);
    
    return Array.from(array, (byte) => 
        byte.toString(16).padStart(2, '0')
    ).join('').substring(0, length);
}
