function escapeCsvCell(value: string): string {
    const text = String(value ?? '');
    if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

export function writeCsv(rows: string[][]): string {
    const lines = rows.map((row) => row.map(escapeCsvCell).join(','));
    return '\uFEFF' + lines.join('\n');
}
