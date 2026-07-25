const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'src', 'hiwords', 'data', 'ecdict.csv');
const OUT_DIR = path.join(__dirname, '..', 'src', 'hiwords', 'data');

function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

function main() {
    const content = fs.readFileSync(CSV_PATH, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    const header = parseCsvLine(lines[0]);
    const wordIdx = header.indexOf('word');
    const translationIdx = header.indexOf('translation');
    const posIdx = header.indexOf('pos');
    const collinsIdx = header.indexOf('collins');
    const oxfordIdx = header.indexOf('oxford');
    const tagIdx = header.indexOf('tag');
    const bncIdx = header.indexOf('bnc');
    const frqIdx = header.indexOf('frq');
    const exchangeIdx = header.indexOf('exchange');
    const phoneticIdx = header.indexOf('phonetic');

    let total = 0;
    let withCollins = 0;
    let withTag = 0;
    let withFreq = 0;
    let collinsOrTagOrFreq = 0;

    const dictionary = {};

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        if (fields.length < header.length) continue;
        total++;

        const word = fields[wordIdx];
        const translation = fields[translationIdx];
        const pos = fields[posIdx];
        const collins = parseInt(fields[collinsIdx], 10) || 0;
        const oxford = parseInt(fields[oxfordIdx], 10) || 0;
        const tag = fields[tagIdx];
        const bnc = parseInt(fields[bncIdx], 10) || 0;
        const frq = parseInt(fields[frqIdx], 10) || 0;
        const exchange = fields[exchangeIdx];
        const phonetic = fields[phoneticIdx];

        if (collins > 0) withCollins++;
        if (tag) withTag++;
        if (bnc > 0 || frq > 0) withFreq++;

        // Filter: keep words that are in Collins, or have exam tags
        if (collins === 0 && !tag) continue;
        collinsOrTagOrFreq++;

        const lowerWord = word.toLowerCase();
        if (dictionary[lowerWord]) continue; // keep first occurrence

        // Build aliases from exchange field, e.g. "p:profiles/d:profiled/i:profiling/3:profiles"
        const aliases = new Set();
        if (exchange) {
            exchange.split('/').forEach(part => {
                const idx = part.indexOf(':');
                if (idx > 0) {
                    const value = part.slice(idx + 1).trim();
                    if (value && value.length > 1 && value.toLowerCase() !== lowerWord) {
                        aliases.add(value.toLowerCase());
                    }
                }
            });
        }

        // Clean translation: remove empty lines and normalize
        const definitions = translation
            .split(/\n/)
            .map(t => t.trim())
            .filter(t => t.length > 0);

        if (definitions.length === 0) continue;

        dictionary[lowerWord] = {
            p: phonetic || undefined,
            d: definitions.slice(0, 5), // keep up to 5 definitions
            a: Array.from(aliases).slice(0, 10) // keep up to 10 aliases
        };
    }

    console.log(`Total entries: ${total}`);
    console.log(`With Collins star: ${withCollins}`);
    console.log(`With exam tag: ${withTag}`);
    console.log(`With frequency data: ${withFreq}`);
    console.log(`Kept entries: ${collinsOrTagOrFreq}`);
    console.log(`Unique words in dictionary: ${Object.keys(dictionary).length}`);

    const outPath = path.join(OUT_DIR, 'dictionary.json');
    fs.writeFileSync(outPath, JSON.stringify(dictionary));
    const stats = fs.statSync(outPath);
    console.log(`Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

main();
