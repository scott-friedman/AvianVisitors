// songbook.js — the tunes the "play" view can sing with the birds.
//
// PUBLIC DOMAIN ONLY. Every tune here is traditional or by a composer long out
// of copyright; do not add anything newer (the site's own licence is
// CC BY-NC-SA, and a melody is a copyrightable work in its own right).
//
// Notation (parsed by AvianSampler.parseMelody in sampler-core.js):
//   letters A–G, optional # or b, an optional octave that STICKS for the notes
//   after it, ":beats" for length (default 1), "r" for a rest, "|" bar lines.
// The key a tune is written in does not matter: nothing is re-pitched, so the
// player slides the whole tune to wherever the birds have the most of its notes.
//
// meter  = beats per bar, pickup = beats before the first full bar. They are
// here for avian/tests/sampler-core.test.mjs, which adds up every bar — a typo
// in a tune fails CI instead of quietly playing a wrong rhythm. (meter 0 = a
// tune with held notes or free rhythm that isn't checked.)
(function (root, factory) {
  var book = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = book;
  else if (root) root.AvianSongbook = book;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return [
    {
      id: 'twinkle', title: 'Twinkle, Twinkle, Little Star', by: 'traditional', bpm: 110, meter: 4,
      notes: 'C4 C G G | A A G:2 | F F E E | D D C:2 | G G F F | E E D:2 | G G F F | E E D:2 | ' +
             'C C G G | A A G:2 | F F E E | D D C:2'
    },
    {
      id: 'ode', title: 'Ode to Joy', by: 'Beethoven', bpm: 120, meter: 4,
      notes: 'E4 E F G | G F E D | C C D E | E:1.5 D:0.5 D:2 | E E F G | G F E D | C C D E | D:1.5 C:0.5 C:2 | ' +
             'D D E C | D E:0.5 F:0.5 E C | D E:0.5 F:0.5 E D | C D G3:2 | ' +
             'E4 E F G | G F E D | C C D E | D:1.5 C:0.5 C:2'
    },
    {
      id: 'morning', title: 'Morning Mood', by: 'Grieg', bpm: 92, meter: 3,
      notes: 'G4:0.5 E:0.5 D:0.5 C:0.5 D:0.5 E:0.5 | G:0.5 E:0.5 D:0.5 C:0.5 D:0.25 E:0.25 D:0.25 E:0.25 | ' +
             'G:0.5 E:0.5 G:0.5 A:0.5 E:0.5 A:0.5 | G:0.5 E:0.5 D:0.5 C:1.5'
    },
    {
      id: 'jacques', title: 'Frère Jacques', by: 'traditional', bpm: 120, meter: 4,
      notes: 'C4 D E C | C D E C | E F G:2 | E F G:2 | G:0.5 A:0.5 G:0.5 F:0.5 E C | ' +
             'G:0.5 A:0.5 G:0.5 F:0.5 E C | C G3 C4:2 | C G3 C4:2'
    },
    {
      id: 'mary', title: 'Mary Had a Little Lamb', by: 'traditional', bpm: 120, meter: 4,
      notes: 'E4 D C D | E E E:2 | D D D:2 | E G G:2 | E D C D | E E E E | D D E D | C:4'
    },
    {
      id: 'buns', title: 'Hot Cross Buns', by: 'traditional', bpm: 108, meter: 4,
      notes: 'E4 D C:2 | E D C:2 | C:0.5 C:0.5 C:0.5 C:0.5 D:0.5 D:0.5 D:0.5 D:0.5 | E D C:2'
    },
    {
      id: 'lune', title: 'Au clair de la lune', by: 'traditional', bpm: 112, meter: 4,
      notes: 'C4 C C D | E:2 D:2 | C E D D | C:4 | C C C D | E:2 D:2 | C E D D | C:4 | ' +
             'D D D D | A3:2 A:2 | D4 C B3 A | G:4 | C4 C C D | E:2 D:2 | C E D D | C:4'
    },
    {
      id: 'macdonald', title: 'Old MacDonald', by: 'traditional', bpm: 132, meter: 4,
      notes: 'G4 G G D | E E D:2 | B B A A | G:3 D | G G G D | E E D:2 | B B A A | G:4'
    },
    {
      id: 'row', title: 'Row, Row, Row Your Boat', by: 'traditional', bpm: 220, meter: 6,
      notes: 'C4:3 C:3 | C:2 D E:3 | E:2 D E:2 F | G:6 | C5 C C G4 G G | E E E C C C | G:2 F E:2 D | C:6'
    },
    {
      id: 'bridge', title: 'London Bridge', by: 'traditional', bpm: 120, meter: 4,
      notes: 'G4:1.5 A:0.5 G F | E F G:2 | D E F:2 | E F G:2 | G:1.5 A:0.5 G F | E F G:2 | D:2 G:2 | E C:3'
    },
    {
      id: 'yankee', title: 'Yankee Doodle', by: 'traditional', bpm: 138, meter: 4,
      notes: 'C4 C D E | C E D G3 | C4 C D E | C:2 B3:2 | C4 C D E | F E D C | B3 G A B | C4:2 C:2 | ' +
             'A3:1.5 B:0.5 A G | A B C4:2 | G3:1.5 A:0.5 G F | E:2 G:2 | ' +
             'A:1.5 B:0.5 A G | A B C4 A3 | G C4 B3 D4 | C:2 C:2'
    },
    {
      id: 'susanna', title: 'Oh! Susanna', by: 'Stephen Foster', bpm: 132, meter: 4, pickup: 1,
      notes: 'C4:0.5 D:0.5 | E G G:1.5 A:0.5 | G E C:1.5 D:0.5 | E E D C | D:3 C:0.5 D:0.5 | ' +
             'E G G:1.5 A:0.5 | G E C:1.5 D:0.5 | E E D D | C:3'
    },
    {
      id: 'saints', title: 'When the Saints Go Marching In', by: 'traditional', bpm: 150, meter: 4, pickup: 3,
      notes: 'C4 E F | G:4 | r C E F | G:4 | r C E F | G:2 E:2 | C:2 E:2 | D:4 | ' +
             'r E E D | C:3 C | E:2 G:2 | G F:3 | r:2 E F | G:2 E:2 | C:2 D:2 | C:4'
    },
    {
      id: 'auld', title: 'Auld Lang Syne', by: 'traditional', bpm: 96, meter: 4, pickup: 1,
      notes: 'G3 | C4:1.5 C:0.5 C E | D:1.5 C:0.5 D E | C:1.5 C:0.5 E G | A:3 A | ' +
             'G:1.5 E:0.5 E C | D:1.5 C:0.5 D E | C:1.5 A3:0.5 A G | C4:3'
    },
    {
      id: 'grace', title: 'Amazing Grace', by: 'traditional', bpm: 84, meter: 3, pickup: 1,
      notes: 'D4 | G:2 B:0.5 G:0.5 | B:2 A | G:2 E | D:2 D | G:2 B:0.5 G:0.5 | B:2 A | D5:3 | D:2 B4 | ' +
             'D5:1.5 B4:0.5 D5:0.5 B4:0.5 | G:2 D | E:1.5 G:0.5 G:0.5 E:0.5 | D:2 D | ' +
             'G:2 B:0.5 G:0.5 | B:2 A | G:3'
    },
    {
      id: 'greensleeves', title: 'Greensleeves', by: 'traditional', bpm: 132, meter: 3, pickup: 1,
      notes: 'A4 | C5:2 D | E:1.5 F:0.5 E | D:2 B4 | G:1.5 A:0.5 B | C5:2 A4 | A:1.5 G#:0.5 A | B:2 G# | E:2 A | ' +
             'C5:2 D | E:1.5 F:0.5 E | D:2 B4 | G:1.5 A:0.5 B | C5:1.5 B4:0.5 A | G#:1.5 F#:0.5 G# | A:3 | A:3 | ' +
             'G5:3 | G:1.5 F#:0.5 E | D:2 B4 | G:1.5 A:0.5 B | C5:2 A4 | A:1.5 G#:0.5 A | B:2 G# | E:3 | ' +
             'G5:3 | G:1.5 F#:0.5 E | D:2 B4 | G:1.5 A:0.5 B | C5:1.5 B4:0.5 A | G#:1.5 F#:0.5 G# | A:3 | A:3'
    },
    {
      id: 'lullaby', title: 'Brahms’ Lullaby', by: 'Brahms', bpm: 92, meter: 3, pickup: 1,
      notes: 'E4:0.5 E:0.5 | G:1.5 E:0.5 E | G:2 E:0.5 G:0.5 | C5 B4:1.5 A:0.5 | A G D:0.5 E:0.5 | ' +
             'F D D:0.5 E:0.5 | F:2 D:0.5 F:0.5 | B:0.5 A:0.5 G B | C5:2 C4:0.5 C:0.5 | ' +
             'C5:2 A4:0.5 F:0.5 | G:2 E:0.5 C:0.5 | F G A | G:2 C:0.5 C:0.5 | ' +
             'C5:2 A4:0.5 F:0.5 | G:2 E:0.5 C:0.5 | F E D | C:2'
    },
    {
      id: 'birthday', title: 'Happy Birthday', by: 'traditional', bpm: 104, meter: 3, pickup: 1,
      notes: 'G4:0.75 G:0.25 | A G C5 | B4:2 G:0.75 G:0.25 | A G D5 | C:2 G4:0.75 G:0.25 | ' +
             'G5 E C | B4 A F5:0.75 F:0.25 | E C D | C:2'
    },
    {
      id: 'jingle', title: 'Jingle Bells', by: 'James Pierpont', bpm: 152, meter: 4,
      notes: 'E4 E E:2 | E E E:2 | E G C:1.5 D:0.5 | E:4 | F F F:1.5 F:0.5 | F E E E:0.5 E:0.5 | E D D E | D:2 G:2 | ' +
             'E E E:2 | E E E:2 | E G C:1.5 D:0.5 | E:4 | F F F:1.5 F:0.5 | F E E E:0.5 E:0.5 | G G F D | C:4'
    },
    {
      id: 'deck', title: 'Deck the Halls', by: 'traditional', bpm: 144, meter: 4,
      notes: 'G4:1.5 F:0.5 E D | C D E C | D:0.5 E:0.5 F:0.5 D:0.5 E:1.5 D:0.5 | C B3 C4:2 | ' +
             'G:1.5 F:0.5 E D | C D E C | D:0.5 E:0.5 F:0.5 D:0.5 E:1.5 D:0.5 | C B3 C4:2 | ' +
             'D:1.5 E:0.5 F D | E:1.5 F:0.5 G D | E:0.5 F#:0.5 G A:0.5 B:0.5 C5 | B4 A G:2 | ' +
             'G:1.5 F:0.5 E D | C D E C | A:0.5 A:0.5 A:0.5 A:0.5 G:1.5 F:0.5 | E D C:2'
    },
    {
      id: 'joy', title: 'Joy to the World', by: 'Handel / Mason', bpm: 112, meter: 4,
      notes: 'C5:2 B4:1.5 A:0.5 | G:3 F | E:2 D:2 | C:3 G | A:3 A | B:3 B | C5:3 C | C B4 A G | ' +
             'G:1.5 F:0.5 E C5 | C B4 A G | G:1.5 F:0.5 E E | E E E E:0.5 F:0.5 | G:3 F:0.5 E:0.5 | ' +
             'D D D D:0.5 E:0.5 | F:3 E:0.5 D:0.5 | C C5:2 A4 | G:1.5 F:0.5 E F | E:2 D:2 | C:4'
    },
    {
      id: 'minuet', title: 'Minuet in G', by: 'Petzold (Bach’s notebook)', bpm: 126, meter: 3,
      notes: 'D5 G4:0.5 A:0.5 B:0.5 C5:0.5 | D G4 G | E5 C:0.5 D:0.5 E:0.5 F#:0.5 | G G4 G | ' +
             'C5 D:0.5 C:0.5 B4:0.5 A:0.5 | B C5:0.5 B4:0.5 A:0.5 G:0.5 | F# G:0.5 A:0.5 B:0.5 G:0.5 | A:3 | ' +
             'D5 G4:0.5 A:0.5 B:0.5 C5:0.5 | D G4 G | E5 C:0.5 D:0.5 E:0.5 F#:0.5 | G G4 G | ' +
             'C5 D:0.5 C:0.5 B4:0.5 A:0.5 | B C5:0.5 B4:0.5 A:0.5 G:0.5 | A B:0.5 A:0.5 G:0.5 F#:0.5 | G:3'
    },
    {
      id: 'elise', title: 'Für Elise', by: 'Beethoven', bpm: 132, meter: 3, pickup: 1,
      notes: 'E5:0.5 D#:0.5 | E:0.5 D#:0.5 E:0.5 B4:0.5 D5:0.5 C:0.5 | A4 r:0.5 C:0.5 E:0.5 A:0.5 | ' +
             'B r:0.5 E:0.5 G#:0.5 B:0.5 | C5 r:0.5 E4:0.5 E5:0.5 D#:0.5 | ' +
             'E:0.5 D#:0.5 E:0.5 B4:0.5 D5:0.5 C:0.5 | A4 r:0.5 C:0.5 E:0.5 A:0.5 | ' +
             'B r:0.5 E:0.5 C5:0.5 B4:0.5 | A:2'
    },
    {
      id: 'nachtmusik', title: 'Eine kleine Nachtmusik', by: 'Mozart', bpm: 132, meter: 4,
      notes: 'G4 r:0.5 D:0.5 G r:0.5 D:0.5 | G:0.5 D:0.5 G:0.5 B:0.5 D5 r | ' +
             'C5 r:0.5 A4:0.5 C5 r:0.5 A4:0.5 | C5:0.5 A4:0.5 F#:0.5 A:0.5 D r'
    },
    {
      id: 'mountain', title: 'In the Hall of the Mountain King', by: 'Grieg', bpm: 132, meter: 4,
      notes: 'A3:0.5 B:0.5 C4:0.5 D:0.5 E:0.5 C:0.5 E | D#:0.5 B3:0.5 D#4 D:0.5 A#3:0.5 D4 | ' +
             'A3:0.5 B:0.5 C4:0.5 D:0.5 E:0.5 C:0.5 E:0.5 A:0.5 | G:0.5 E:0.5 C:0.5 E:0.5 G:2 | ' +
             'E4:0.5 F#:0.5 G:0.5 A:0.5 B:0.5 G:0.5 B | A#:0.5 F#:0.5 A# A:0.5 F:0.5 A | ' +
             'E:0.5 F#:0.5 G:0.5 A:0.5 B:0.5 G:0.5 B:0.5 E5:0.5 | D:0.5 B4:0.5 G:0.5 B:0.5 D5:2'
    },
    {
      id: 'cancan', title: 'Can-Can', by: 'Offenbach', bpm: 176, meter: 4,
      notes: 'D4:2 E:0.5 G:0.5 F#:0.5 E:0.5 | A A A:0.5 B:0.5 F#:0.5 G:0.5 | E E E:0.5 G:0.5 F#:0.5 E:0.5 | ' +
             'D:0.5 D5:0.5 C#:0.5 B4:0.5 A:0.5 G:0.5 F#:0.5 E:0.5 | D:2 E:0.5 G:0.5 F#:0.5 E:0.5 | ' +
             'A A A:0.5 B:0.5 F#:0.5 G:0.5 | E E E:0.5 G:0.5 F#:0.5 E:0.5 | D:0.5 A:0.5 E:0.5 F#:0.5 D:2'
    },
    {
      id: 'fifth', title: 'Beethoven’s Fifth (the knock)', by: 'Beethoven', bpm: 108, meter: 0,
      notes: 'r:0.5 G4:0.5 G:0.5 G:0.5 Eb:3 r | r:0.5 F:0.5 F:0.5 F:0.5 D:4'
    },
    {
      id: 'shave', title: 'Shave and a Haircut', by: 'traditional', bpm: 132, meter: 4,
      notes: 'C5 G4:0.5 G:0.5 A G | r B C5 r'
    }
  ];
});
