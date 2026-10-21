export interface SpicySyllable {
    Text: string;
    IsPartOfWord?: boolean;
    StartTime: number;
    EndTime: number;
}

export interface SpicyVocalGroup {
    Syllables: SpicySyllable[];
    StartTime: number;
    EndTime: number;
}

export interface SpicySyllableLine {
    Type: 'Vocal';
    OppositeAligned?: boolean;
    Lead: SpicyVocalGroup;
    Background?: SpicyVocalGroup[];
}

export interface SpicyLineLine {
    Type: 'Vocal';
    OppositeAligned?: boolean;
    Text: string;
    StartTime: number;
    EndTime: number;
}

export type SpicyLyricsBody =
    | { Type: 'Syllable', Content: SpicySyllableLine[], StartTime?: number, EndTime?: number, SongWriters?: string[] }
    | { Type: 'Line', Content: SpicyLineLine[], StartTime?: number, EndTime?: number, SongWriters?: string[] }
    | { Type: 'Static', SongWriters?: string[] };

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function time(seconds: number): string {
    return seconds.toFixed(3);
}

function agent(line: { OppositeAligned?: boolean }): string {
    return line.OppositeAligned ? 'v2' : 'v1';
}

function syllableSpans(syllables: SpicySyllable[], wrapInParens: boolean): string {
    return syllables.map((syllable, i) => {
        const isLast = i === syllables.length - 1;
        let text = syllable.Text;
        if (!isLast && !syllable.IsPartOfWord) text += ' ';
        if (wrapInParens && i === 0) text = `(${text}`;
        if (wrapInParens && isLast) text = `${text})`;
        return `<span begin="${time(syllable.StartTime)}" end="${time(syllable.EndTime)}">${escapeXml(text)}</span>`;
    }).join('');
}

function syllableLine(line: SpicySyllableLine): string {
    const background = line.Background ?? [];
    const begin = Math.min(line.Lead.StartTime, ...background.map(group => group.StartTime));
    const end = Math.max(line.Lead.EndTime, ...background.map(group => group.EndTime));
    const backgroundSpans = background
        .map(group => `<span ttm:role="x-bg">${syllableSpans(group.Syllables, true)}</span>`)
        .join('');
    return `<p begin="${time(begin)}" end="${time(end)}" ttm:agent="${agent(line)}">${syllableSpans(line.Lead.Syllables, false)}${backgroundSpans}</p>`;
}

function lineLine(line: SpicyLineLine): string {
    return `<p begin="${time(line.StartTime)}" end="${time(line.EndTime)}" ttm:agent="${agent(line)}">${escapeXml(line.Text)}</p>`;
}

export function spicyToTtml(body: SpicyLyricsBody): string | null {
    if (body.Type === 'Static' || body.Content.length === 0) return null;

    const lines = body.Type === 'Syllable'
        ? body.Content.map(syllableLine)
        : body.Content.map(lineLine);
    const songwriters = (body.SongWriters ?? [])
        .map(name => `<songwriter>${escapeXml(name)}</songwriter>`)
        .join('');

    return '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ' +
        `xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="${body.Type === 'Syllable' ? 'Word' : 'Line'}">` +
        '<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>' +
        `<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters>${songwriters}</songwriters></iTunesMetadata>` +
        `</metadata></head><body><div>${lines.join('')}</div></body></tt>`;
}
