import { describe, expect, it } from 'vitest';
import { spicyToTtml, SpicyLyricsBody } from '../src/providers/spicyTtml';

// Shaped like the live Spicy Lyrics community sync for 1QV6tiMFM6fSOKOGLMHYYg.
const syllableBody: SpicyLyricsBody = {
    Type: 'Syllable',
    StartTime: 7.337,
    EndTime: 28.241,
    SongWriters: ['Stefani Joanne Angelina Germanotta', 'Nādir Ḵayyāṭ'],
    Content: [
        {
            Type: 'Vocal',
            OppositeAligned: false,
            Lead: {
                Syllables: [
                    { Text: 'Mum-', IsPartOfWord: true, StartTime: 7.337, EndTime: 7.625 },
                    { Text: 'mum-', IsPartOfWord: true, StartTime: 7.625, EndTime: 7.888 },
                    { Text: 'mum-', IsPartOfWord: true, StartTime: 7.888, EndTime: 8.169 },
                    { Text: 'mah', IsPartOfWord: false, StartTime: 8.169, EndTime: 8.69 },
                ],
                StartTime: 7.337,
                EndTime: 8.69,
            },
        },
        {
            Type: 'Vocal',
            OppositeAligned: true,
            Lead: {
                Syllables: [
                    { Text: 'Tex', IsPartOfWord: true, StartTime: 26.782, EndTime: 27.013 },
                    { Text: 'as,', IsPartOfWord: false, StartTime: 27.013, EndTime: 27.342 },
                    { Text: 'please', IsPartOfWord: true, StartTime: 27.342, EndTime: 28.063 },
                ],
                StartTime: 26.782,
                EndTime: 28.241,
            },
            Background: [
                {
                    Syllables: [
                        { Text: 'no', IsPartOfWord: false, StartTime: 27.85, EndTime: 28.0 },
                        { Text: 'bo', IsPartOfWord: true, StartTime: 28.0, EndTime: 28.1 },
                        { Text: 'dy', IsPartOfWord: false, StartTime: 28.1, EndTime: 28.241 },
                    ],
                    StartTime: 27.85,
                    EndTime: 28.241,
                },
            ],
        },
    ],
};

describe('spicyToTtml', () => {
    it('converts syllable lyrics to word-synced TTML', () => {
        const ttml = spicyToTtml(syllableBody)!;

        expect(ttml).toContain('itunes:timing="Word"');
        expect(ttml).toContain('<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>');
        expect(ttml).toContain('<songwriter>Nādir Ḵayyāṭ</songwriter>');
        expect(ttml).toContain(
            '<p begin="7.337" end="8.690" ttm:agent="v1">' +
            '<span begin="7.337" end="7.625">Mum-</span><span begin="7.625" end="7.888">mum-</span>' +
            '<span begin="7.888" end="8.169">mum-</span><span begin="8.169" end="8.690">mah</span></p>',
        );
    });

    it('maps opposite aligned lines to v2 and background vocals to x-bg', () => {
        const ttml = spicyToTtml(syllableBody)!;

        expect(ttml).toContain(
            '<p begin="26.782" end="28.241" ttm:agent="v2">' +
            '<span begin="26.782" end="27.013">Tex</span><span begin="27.013" end="27.342">as, </span>' +
            '<span begin="27.342" end="28.063">please</span>' +
            '<span ttm:role="x-bg"><span begin="27.850" end="28.000">(no </span>' +
            '<span begin="28.000" end="28.100">bo</span><span begin="28.100" end="28.241">dy)</span></span></p>',
        );
    });

    it('converts line lyrics to line-synced TTML', () => {
        const ttml = spicyToTtml({
            Type: 'Line',
            Content: [{ Type: 'Vocal', OppositeAligned: false, Text: 'Hold me (hold me)', StartTime: 10.81, EndTime: 13.2 }],
        })!;

        expect(ttml).toContain('itunes:timing="Line"');
        expect(ttml).toContain('<p begin="10.810" end="13.200" ttm:agent="v1">Hold me (hold me)</p>');
    });

    it('escapes XML special characters', () => {
        const ttml = spicyToTtml({
            Type: 'Line',
            SongWriters: ['A & B'],
            Content: [{ Type: 'Vocal', OppositeAligned: false, Text: 'R&B <3 "quoted"', StartTime: 1, EndTime: 2 }],
        })!;

        expect(ttml).toContain('>R&amp;B &lt;3 &quot;quoted&quot;</p>');
        expect(ttml).toContain('<songwriter>A &amp; B</songwriter>');
    });

    it('regression: starts the line at a background vocal that begins before the lead', () => {
        const ttml = spicyToTtml({
            Type: 'Syllable',
            Content: [{
                Type: 'Vocal',
                Lead: { Syllables: [{ Text: 'lead', StartTime: 2, EndTime: 3 }], StartTime: 2, EndTime: 3 },
                Background: [{ Syllables: [{ Text: 'bg', StartTime: 1, EndTime: 2 }], StartTime: 1, EndTime: 2 }],
            }],
        })!;

        expect(ttml).toContain('<p begin="1.000" end="3.000" ttm:agent="v1">');
    });

    it('returns null for static or empty lyrics', () => {
        expect(spicyToTtml({ Type: 'Static' })).toBeNull();
        expect(spicyToTtml({ Type: 'Syllable', Content: [] })).toBeNull();
    });
});
