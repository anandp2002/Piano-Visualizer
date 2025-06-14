// PianoKeyboard.jsx
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import * as Tone from 'tone';
import {
  KEYS,
  WHITE_KEYS,
  BLACK_KEYS,
  NUM_WHITE_KEYS,
  COMPUTER_KEY_TO_NOTE,
} from '../utils/Keys';

// --- Constants ---
const BLACK_KEY_WIDTH_RATIO = 0.65;
const KEYBOARD_HEIGHT = 256;
const ANIMATION_AREA_HEIGHT = 300;
const NOTE_RISE_SPEED_PPS = 120;
const NOTE_FADEOUT_DURATION_MS = 5000;

// --- Custom Hook ---
const useResizeObserver = (ref) => {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [ref]);
  return dimensions;
};

const PianoKeyboard = () => {
  // --- State ---
  const [pressedKeys, setPressedKeys] = useState(new Set());
  const [notesToRender, setNotesToRender] = useState([]);
  const [keyDimensions, setKeyDimensions] = useState({
    whiteKeyWidth: 0,
    blackKeyWidth: 0,
  });
  const [midiWarning, setMidiWarning] = useState('');
  const [midiDeviceName, setMidiDeviceName] = useState(
    'No MIDI device connected.'
  );

  // --- Refs ---
  const synth = useRef(null);
  const animationFrameRef = useRef(null);
  const noteIdCounter = useRef(0);
  const activeVisualNotes = useRef(new Map());
  const heldKeysRef = useRef(new Set());
  const keyboardContainerRef = useRef(null);
  const dimensionsRef = useRef(keyDimensions);

  // --- Measure container and calculate responsive key sizes ---
  const { width: containerWidth } = useResizeObserver(keyboardContainerRef);
  useEffect(() => {
    if (containerWidth > 0) {
      const whiteKeyWidth = containerWidth / NUM_WHITE_KEYS;
      const blackKeyWidth = whiteKeyWidth * BLACK_KEY_WIDTH_RATIO;
      const newDimensions = { whiteKeyWidth, blackKeyWidth };
      setKeyDimensions(newDimensions);
      dimensionsRef.current = newDimensions;
    }
  }, [containerWidth]);

  // --- 1. Initialize Audio & Animation Loop ---
  useEffect(() => {
    synth.current = new Tone.PolySynth(Tone.Synth, {
      oscillator: {
        type: 'fmtriangle',
        harmonicity: 0.5,
        modulationType: 'sine',
      },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.4, release: 2 },
    }).toDestination();
    return () => synth.current?.dispose();
  }, []);

  useEffect(() => {
    const animateNotes = (currentTime) => {
      const notesToDelete = [];
      activeVisualNotes.current.forEach((note) => {
        if (!note.element) return;
        if (!note.endTime) {
          const durationMs = currentTime - note.startTime;
          const height = (durationMs / 1000) * NOTE_RISE_SPEED_PPS;
          note.element.style.height = `${height}px`;
          note.currentHeight = height;
          if (note.durationElement) {
            note.durationElement.textContent = `${(durationMs / 1000).toFixed(
              1
            )}s`;
          }
        } else {
          const timeSinceRelease = currentTime - note.endTime;
          const slideDistance = (timeSinceRelease / 1000) * NOTE_RISE_SPEED_PPS;
          note.element.style.bottom = `${slideDistance}px`;
          const opacity = 1 - timeSinceRelease / NOTE_FADEOUT_DURATION_MS;
          note.element.style.opacity = Math.max(0, opacity * 0.9).toString();
          if (slideDistance > ANIMATION_AREA_HEIGHT) {
            notesToDelete.push(note.id);
          }
        }
      });
      if (notesToDelete.length > 0) {
        notesToDelete.forEach((id) => activeVisualNotes.current.delete(id));
        setNotesToRender(Array.from(activeVisualNotes.current.values()));
      }
      animationFrameRef.current = requestAnimationFrame(animateNotes);
    };
    animationFrameRef.current = requestAnimationFrame(animateNotes);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, []);

  // --- 2. Note On/Off Handlers ---
  const handleNoteOn = useCallback((keyData) => {
    if (heldKeysRef.current.has(keyData.note)) return;
    Tone.start();
    synth.current.triggerAttack(keyData.note);
    heldKeysRef.current.add(keyData.note);
    setPressedKeys((prev) => new Set(prev).add(keyData.note));
    const { whiteKeyWidth, blackKeyWidth } = dimensionsRef.current;
    if (whiteKeyWidth === 0) return;
    const noteId = ++noteIdCounter.current;
    const isBlackKey = keyData.type === 'black';
    const left = isBlackKey
      ? (keyData.whiteKeyIndex + 1) * whiteKeyWidth - blackKeyWidth / 2
      : keyData.whiteKeyIndex * whiteKeyWidth;
    const newVisualNote = {
      id: noteId,
      noteName: keyData.note,
      startTime: performance.now(),
      endTime: null,
      currentHeight: 0,
      element: null,
      durationElement: null,
      left: left,
      width: isBlackKey ? blackKeyWidth : whiteKeyWidth,
      color: isBlackKey ? '#8b5cf6' : '#3b82f6',
    };
    activeVisualNotes.current.set(noteId, newVisualNote);
    setNotesToRender(Array.from(activeVisualNotes.current.values()));
  }, []);

  const handleNoteOff = useCallback((keyData) => {
    if (!heldKeysRef.current.has(keyData.note)) return;
    synth.current.triggerRelease(keyData.note);
    heldKeysRef.current.delete(keyData.note);
    setPressedKeys((prev) => {
      const newSet = new Set(prev);
      newSet.delete(keyData.note);
      return newSet;
    });
    const now = performance.now();
    activeVisualNotes.current.forEach((note) => {
      if (note.noteName === keyData.note && !note.endTime) {
        note.endTime = now;
        note.element.style.height = `${note.currentHeight}px`;
      }
    });
  }, []);

  // --- 3. MIDI & Computer Keyboard Input ---
  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      setMidiWarning('Web MIDI API not supported. Please use Chrome or Edge.');
      return;
    }
    let midiAccess;
    const onMIDIMessage = (message) => {
      const [command, noteMidi, velocity] = message.data;
      const keyData = KEYS.find((k) => k.midi === noteMidi);
      if (!keyData) return;
      if (command === 144 && velocity > 0) handleNoteOn(keyData);
      else if (command === 128 || (command === 144 && velocity === 0))
        handleNoteOff(keyData);
    };
    const updateMidiDevices = (midi) => {
      for (let input of midi.inputs.values()) {
        input.onmidimessage = null;
      }
      const connectedInputs = Array.from(midi.inputs.values());
      if (connectedInputs.length > 0) {
        const deviceNames = connectedInputs
          .map((input) => input.name)
          .join(', ');
        setMidiDeviceName(`Connected: ${deviceNames}`);
        setMidiWarning('');
        for (let input of connectedInputs) {
          input.onmidimessage = onMIDIMessage;
        }
      } else {
        setMidiDeviceName('No MIDI device connected.');
      }
    };
    const onMIDISuccess = (midi) => {
      midiAccess = midi;
      updateMidiDevices(midiAccess);
      midiAccess.onstatechange = () => updateMidiDevices(midiAccess);
    };
    navigator
      .requestMIDIAccess()
      .then(onMIDISuccess, (err) =>
        setMidiWarning(`MIDI Error: ${err.message}`)
      );
    return () => {
      if (midiAccess) {
        midiAccess.onstatechange = null;
        for (let input of midiAccess.inputs.values()) {
          input.onmidimessage = null;
        }
      }
    };
  }, [handleNoteOn, handleNoteOff]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.repeat) return;
      const noteName = COMPUTER_KEY_TO_NOTE[e.code];
      if (noteName) {
        const keyData = KEYS.find((k) => k.note === noteName);
        if (keyData) handleNoteOn(keyData);
      }
    };
    const handleKeyUp = (e) => {
      const noteName = COMPUTER_KEY_TO_NOTE[e.code];
      if (noteName) {
        const keyData = KEYS.find((k) => k.note === noteName);
        if (keyData) handleNoteOff(keyData);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleNoteOn, handleNoteOff]);

  // --- 4. JSX Rendering ---
  return (
    <div
      ref={keyboardContainerRef}
      className="bg-gray-800 p-4 rounded-lg shadow-2xl w-full select-none"
    >
      {/* --- Animation Area with Status Overlay --- */}
      <div
        className="relative overflow-hidden rounded-t-lg"
        style={{ height: `${ANIMATION_AREA_HEIGHT}px` }}
      >
        <div
          className={`
            absolute top-0 left-0 right-0 p-2 text-center text-sm z-20 
            transition-all duration-300
            ${
              midiWarning
                ? 'bg-yellow-500 text-white font-bold'
                : 'bg-gray-700 bg-opacity-30 text-gray-300 font-mono'
            }
          `}
        >
          {midiWarning || midiDeviceName}
        </div>

        {notesToRender.map((note) => (
          <div
            key={note.id}
            ref={(el) => {
              const currentNote = activeVisualNotes.current.get(note.id);
              if (currentNote) {
                currentNote.element = el;
                if (el)
                  currentNote.durationElement = el.querySelector(
                    '.note-duration-text'
                  );
              }
            }}
            className="absolute bottom-0 rounded-md shadow-lg"
            style={{
              left: `${note.left}px`,
              width: `${note.width}px`,
              height: 0,
              opacity: 0.9,
              zIndex: 1,
              backgroundColor: note.color,
              border: `2px solid ${note.color}`,
              boxShadow: `0 0 20px ${note.color}`,
              background: `linear-gradient(180deg, ${note.color}, ${note.color}88)`,
            }}
          >
            <div
              className="absolute top-1 left-0 right-0 text-center font-bold text-white text-shadow-sm truncate"
              style={{ fontSize: note.width > 40 ? '12px' : '10px' }}
            >
              {note.noteName.replace(/\d/g, '')}
            </div>
            <span className="note-duration-text absolute bottom-1 left-0 right-0 text-center text-white text-xs font-mono opacity-75">
              0.0s
            </span>
          </div>
        ))}
      </div>

      {/* --- Keyboard --- */}
      <div className="relative flex w-full rounded-b-lg overflow-hidden mt-[-1px]">
        {WHITE_KEYS.map((key) => (
          <button
            key={key.note}
            onMouseDown={() => handleNoteOn(key)}
            onMouseUp={() => handleNoteOff(key)}
            onMouseLeave={() => handleNoteOff(key)}
            className={`
              relative border-r border-b border-gray-400 text-gray-800 flex items-end justify-center pb-2 transition-all duration-75 ease-in-out
              ${
                pressedKeys.has(key.note)
                  ? 'bg-blue-300 translate-y-1 shadow-inner'
                  : 'bg-white hover:bg-gray-100'
              }
            `}
            style={{
              width: `${keyDimensions.whiteKeyWidth}px`,
              height: `${KEYBOARD_HEIGHT}px`,
            }}
          >
            {/* === UPDATED: Split note name into two lines for readability === */}
            <div className="flex flex-col items-center leading-none text-xs sm:text-base">
              <span className="font-semibold">{key.note.slice(0, 1)}</span>
              <span className="opacity-75 text-[0.8em]">
                {key.note.slice(1)}
              </span>
            </div>
          </button>
        ))}
        {BLACK_KEYS.map((key) => (
          <button
            key={key.note}
            onMouseDown={() => handleNoteOn(key)}
            onMouseUp={() => handleNoteOff(key)}
            onMouseLeave={() => handleNoteOff(key)}
            className={`
              absolute top-0 rounded-b-md h-40 border border-t-0 border-gray-800 text-white flex items-end justify-center pb-2 transition-all duration-75 ease-in-out z-10
              ${
                pressedKeys.has(key.note)
                  ? 'bg-purple-600 h-[9.8rem]'
                  : 'bg-gray-800 hover:bg-gray-700'
              }
            `}
            style={{
              width: `${keyDimensions.blackKeyWidth}px`,
              left: `${
                (key.whiteKeyIndex + 1) * keyDimensions.whiteKeyWidth
              }px`,
              transform: 'translateX(-50%)',
            }}
          >
            {/* === UPDATED: Split note name into two lines for readability === */}
            <div className="flex flex-col items-center leading-none text-xs">
              <span className="">{key.note.slice(0, 1)}</span>
              <span className="opacity-75 text-[0.8em]">
                {key.note.slice(1)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default PianoKeyboard;
