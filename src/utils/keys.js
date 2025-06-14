// keys.js

/**
 * Generates an array of 88 key objects, representing a standard piano keyboard.
 * Each key object contains its note name, type (white/black), MIDI number,
 * and an index for positioning relative to white keys.
 * @returns {Array<Object>} An array of key objects.
 */
const generateKeys = () => {
  const keys = [];
  const noteNames = [
    'C',
    'C#',
    'D',
    'D#',
    'E',
    'F',
    'F#',
    'G',
    'G#',
    'A',
    'A#',
    'B',
  ];
  let whiteKeyIndex = 0;
  // Standard 88-key piano starts at A0 (MIDI 21) and ends at C8 (MIDI 108)
  for (let i = 21; i <= 108; i++) {
    const noteName = noteNames[i % 12];
    const octave = Math.floor(i / 12) - 1;
    const type = noteName.includes('#') ? 'black' : 'white';
    keys.push({
      note: `${noteName}${octave}`,
      type: type,
      midi: i,
      // Associate black keys with the preceding white key for positioning
      whiteKeyIndex: type === 'white' ? whiteKeyIndex : whiteKeyIndex - 1,
    });
    if (type === 'white') whiteKeyIndex++;
  }
  return keys;
};

// --- Static Data (calculated once and exported) ---

/**
 * An array of all 88 piano keys.
 * @type {Array<Object>}
 */
export const KEYS = generateKeys();

/**
 * An array containing only the white key objects.
 * @type {Array<Object>}
 */
export const WHITE_KEYS = KEYS.filter((key) => key.type === 'white');

/**
 * An array containing only the black key objects.
 * @type {Array<Object>}
 */
export const BLACK_KEYS = KEYS.filter((key) => key.type === 'black');

/**
 * The total number of white keys.
 * @type {number}
 */
export const NUM_WHITE_KEYS = WHITE_KEYS.length;

/**
 * A mapping from computer keyboard event codes to piano note names.
 * This defines two octaves for playing with a QWERTY keyboard.
 * @type {Object<string, string>}
 */
export const COMPUTER_KEY_TO_NOTE = {
  // Lower octave row
  KeyZ: 'C3',
  KeyS: 'C#3',
  KeyX: 'D3',
  KeyD: 'D#3',
  KeyC: 'E3',
  KeyV: 'F3',
  KeyG: 'F#3',
  KeyB: 'G3',
  KeyH: 'G#3',
  KeyN: 'A3',
  KeyJ: 'A#3',
  KeyM: 'B3',
  Comma: 'C4',
  KeyL: 'C#4',
  Period: 'D4',
  Semicolon: 'D#4',
  Slash: 'E4',

  // Upper octave row
  KeyQ: 'C4',
  Digit2: 'C#4',
  KeyW: 'D4',
  Digit3: 'D#4',
  KeyE: 'E4',
  KeyR: 'F4',
  Digit5: 'F#4',
  KeyT: 'G4',
  Digit6: 'G#4',
  KeyY: 'A4',
  Digit7: 'A#4',
  KeyU: 'B4',
  KeyI: 'C5',
  Digit9: 'C#5',
  KeyO: 'D5',
  Digit0: 'D#5',
  KeyP: 'E5',
  BracketLeft: 'F5',
  BracketRight: 'F#5',
};
