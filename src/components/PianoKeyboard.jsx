// PianoKeyboard.jsx
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';
import {
  KEYS,
  WHITE_KEYS,
  BLACK_KEYS,
  NUM_WHITE_KEYS,
  COMPUTER_KEY_TO_NOTE,
} from '../utils/keys';

// --- Constants ---
const BLACK_KEY_WIDTH_RATIO = 0.65;
const KEYBOARD_HEIGHT = 256;
const ANIMATION_AREA_HEIGHT = 300;
// Free Play Constants
const NOTE_RISE_SPEED_PPS = 120;
const NOTE_FADEOUT_DURATION_MS = 5000;
// Assisted Play Constants
const NOTE_FALL_SPEED_PPS = 100;
const HIT_WINDOW_MS = 200;
const FEEDBACK_DURATION_MS = 400; // Duration for key color feedback

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
  const [keyDimensions, setKeyDimensions] = useState({
    whiteKeyWidth: 0,
    blackKeyWidth: 0,
  });
  const [midiWarning, setMidiWarning] = useState('');
  const [midiDeviceName, setMidiDeviceName] = useState(
    'No MIDI device connected.'
  );
  const [keyFeedback, setKeyFeedback] = useState(new Map());

  // --- Practice Mode State ---
  const [practiceMode, setPracticeMode] = useState('free');
  const [gameState, setGameState] = useState('idle'); // idle, playing, paused, finished
  const [songNotes, setSongNotes] = useState([]);
  const [visualSongNotes, setVisualSongNotes] = useState([]);
  const [score, setScore] = useState({ hits: 0, misses: 0, mistakes: 0 });
  const [midiFileName, setMidiFileName] = useState(null); // <-- NEW: State for MIDI file name

  // --- Refs ---
  const synth = useRef(null);
  const animationFrameRef = useRef(null);
  const keyboardContainerRef = useRef(null);
  const dimensionsRef = useRef(keyDimensions);
  const feedbackTimeoutRefs = useRef(new Map());

  // Free Play Refs
  const freePlayNoteIdCounter = useRef(0);
  const activeFreePlayNotes = useRef(new Map());
  const heldKeysRef = useRef(new Set());

  // Assisted Play Refs
  const gameStartTime = useRef(0);
  const songData = useRef(null);
  const activelyHeldAssistedNotes = useRef(new Map());
  const pauseStartTime = useRef(0);
  const totalPausedTime = useRef(0);

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
    return () => {
      synth.current?.dispose();
      feedbackTimeoutRefs.current.forEach((timeoutId) =>
        clearTimeout(timeoutId)
      );
    };
  }, []);

  const addKeyFeedback = useCallback((noteName, status) => {
    if (feedbackTimeoutRefs.current.has(noteName)) {
      clearTimeout(feedbackTimeoutRefs.current.get(noteName));
    }
    setKeyFeedback((prev) => new Map(prev).set(noteName, status));
    const timeoutId = setTimeout(() => {
      setKeyFeedback((prev) => {
        const newMap = new Map(prev);
        if (newMap.get(noteName) === status) {
          newMap.delete(noteName);
        }
        return newMap;
      });
      feedbackTimeoutRefs.current.delete(noteName);
    }, FEEDBACK_DURATION_MS);

    feedbackTimeoutRefs.current.set(noteName, timeoutId);
  }, []);

  useEffect(() => {
    const animationLoop = (currentTime) => {
      // Logic only runs when game is actively playing, not paused
      if (practiceMode === 'assisted' && gameState === 'playing') {
        const elapsedTimeS =
          (currentTime - gameStartTime.current - totalPausedTime.current) /
          1000;

        const notesToDisplay = [];
        let missedNotesThisFrame = 0;

        songData.current.forEach((note) => {
          if (note.status === 'finished') return;

          const timeToHit = note.time;
          const timeToSpawn =
            timeToHit - ANIMATION_AREA_HEIGHT / NOTE_FALL_SPEED_PPS;

          if (elapsedTimeS >= timeToSpawn) {
            const noteHeight = note.duration * NOTE_FALL_SPEED_PPS;
            const y = (elapsedTimeS - timeToSpawn) * NOTE_FALL_SPEED_PPS;
            note.y = y;
            const noteTopY = y - noteHeight;

            if (y > ANIMATION_AREA_HEIGHT && note.status === 'upcoming') {
              note.status = 'missed';
              missedNotesThisFrame++;
            }

            if (noteTopY >= ANIMATION_AREA_HEIGHT) {
              note.status = 'finished';
            }

            if (note.status !== 'finished') {
              notesToDisplay.push(note);
            }
          }
        });

        if (missedNotesThisFrame > 0) {
          setScore((s) => ({ ...s, misses: s.misses + missedNotesThisFrame }));
        }
        setVisualSongNotes(notesToDisplay);

        // Check if the song has finished
        const allNotesFinished =
          songData.current.length > 0 &&
          songData.current.every((note) => note.status === 'finished');
        if (allNotesFinished) {
          setGameState('finished');
        }
      } else if (practiceMode === 'free') {
        const notesToDelete = [];
        activeFreePlayNotes.current.forEach((note) => {
          if (!note.element) return;
          if (!note.endTime) {
            const durationMs = currentTime - note.startTime;
            note.element.style.height = `${
              (durationMs / 1000) * NOTE_RISE_SPEED_PPS
            }px`;
          } else {
            const timeSinceRelease = currentTime - note.endTime;
            const slideDistance =
              (timeSinceRelease / 1000) * NOTE_RISE_SPEED_PPS;
            note.element.style.bottom = `${slideDistance}px`;
            const opacity = 1 - timeSinceRelease / NOTE_FADEOUT_DURATION_MS;
            note.element.style.opacity = Math.max(0, opacity * 0.9).toString();
            if (slideDistance > ANIMATION_AREA_HEIGHT) {
              notesToDelete.push(note.id);
            }
          }
        });
        if (notesToDelete.length > 0) {
          notesToDelete.forEach((id) => activeFreePlayNotes.current.delete(id));
          setVisualSongNotes(Array.from(activeFreePlayNotes.current.values()));
        }
      }
      animationFrameRef.current = requestAnimationFrame(animationLoop);
    };
    animationFrameRef.current = requestAnimationFrame(animationLoop);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [practiceMode, gameState]);

  useEffect(() => {
    if (
      practiceMode !== 'assisted' ||
      keyDimensions.whiteKeyWidth === 0 ||
      !songData.current
    ) {
      return;
    }
    const updatedNotes = songData.current.map((note) => {
      const keyData = KEYS.find((k) => k.note === note.name);
      if (!keyData) return note;
      const isBlackKey = keyData.type === 'black';
      const { whiteKeyWidth, blackKeyWidth } = keyDimensions;
      return {
        ...note,
        left: isBlackKey
          ? (keyData.whiteKeyIndex + 1) * whiteKeyWidth - blackKeyWidth / 2
          : keyData.whiteKeyIndex * whiteKeyWidth,
        width: isBlackKey ? blackKeyWidth : whiteKeyWidth,
      };
    });
    songData.current = updatedNotes;
    setSongNotes(updatedNotes);
  }, [keyDimensions, practiceMode]);

  // --- 2. Note On/Off Handlers ---
  const handleNoteOn = useCallback(
    (keyData) => {
      if (heldKeysRef.current.has(keyData.note)) return;
      Tone.start();
      synth.current.triggerAttack(keyData.note);
      heldKeysRef.current.add(keyData.note);
      setPressedKeys((prev) => new Set(prev).add(keyData.note));

      if (practiceMode === 'assisted') {
        if (gameState !== 'playing') return; // Ignore presses if not playing

        const nowMs = performance.now();
        const elapsedTimeS =
          (nowMs - gameStartTime.current - totalPausedTime.current) / 1000;
        const hitWindowS = HIT_WINDOW_MS / 1000;
        const targetNote = songData.current.find(
          (n) =>
            n.name === keyData.note &&
            n.status === 'upcoming' &&
            Math.abs(n.time - elapsedTimeS) < hitWindowS
        );

        if (targetNote) {
          targetNote.status = 'hit';
          activelyHeldAssistedNotes.current.set(keyData.note, targetNote);
          setScore((s) => ({ ...s, hits: s.hits + 1 }));
          addKeyFeedback(keyData.note, 'hit');
        } else {
          setScore((s) => ({ ...s, mistakes: s.mistakes + 1 }));
          addKeyFeedback(keyData.note, 'mistake');
        }
      } else if (practiceMode === 'free') {
        const { whiteKeyWidth, blackKeyWidth } = dimensionsRef.current;
        if (whiteKeyWidth === 0) return;
        const noteId = ++freePlayNoteIdCounter.current;
        const isBlackKey = keyData.type === 'black';
        const left = isBlackKey
          ? (keyData.whiteKeyIndex + 1) * whiteKeyWidth - blackKeyWidth / 2
          : keyData.whiteKeyIndex * whiteKeyWidth;
        const newVisualNote = {
          id: noteId,
          noteName: keyData.note,
          startTime: performance.now(),
          endTime: null,
          element: null,
          left: left,
          width: isBlackKey ? blackKeyWidth : whiteKeyWidth,
          color: isBlackKey ? '#8b5cf6' : '#3b82f6',
        };
        activeFreePlayNotes.current.set(noteId, newVisualNote);
        setVisualSongNotes(Array.from(activeFreePlayNotes.current.values()));
      }
    },
    [practiceMode, gameState, addKeyFeedback]
  );

  const handleNoteOff = useCallback(
    (keyData) => {
      if (!heldKeysRef.current.has(keyData.note)) return;
      synth.current.triggerRelease(keyData.note);
      heldKeysRef.current.delete(keyData.note);
      setPressedKeys((prev) => {
        const newSet = new Set(prev);
        newSet.delete(keyData.note);
        return newSet;
      });

      if (practiceMode === 'assisted') {
        if (gameState !== 'playing') return; // Ignore releases if not playing

        if (activelyHeldAssistedNotes.current.has(keyData.note)) {
          const heldNote = activelyHeldAssistedNotes.current.get(keyData.note);
          const elapsedTimeS =
            (performance.now() -
              gameStartTime.current -
              totalPausedTime.current) /
            1000;
          const noteEndTime = heldNote.time + heldNote.duration;

          if (elapsedTimeS < noteEndTime) {
            heldNote.status = 'early_release';
            setScore((s) => ({
              ...s,
              hits: s.hits - 1,
              mistakes: s.mistakes + 1,
            }));
          }
          activelyHeldAssistedNotes.current.delete(keyData.note);
        }
      } else if (practiceMode === 'free') {
        const now = performance.now();
        activeFreePlayNotes.current.forEach((note) => {
          if (note.noteName === keyData.note && !note.endTime) {
            note.endTime = now;
          }
        });
      }
    },
    [practiceMode, gameState]
  );

  // --- 3. MIDI & Computer Keyboard Input ---
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
      const inputs = Array.from(midi.inputs.values());
      inputs.forEach((input) => (input.onmidimessage = onMIDIMessage));
      const deviceNames = inputs.map((i) => i.name).join(', ');
      setMidiDeviceName(
        deviceNames ? `Connected: ${deviceNames}` : 'No MIDI device connected.'
      );
      setMidiWarning('');
    };
    navigator.requestMIDIAccess().then((midi) => {
      midiAccess = midi;
      updateMidiDevices(midi);
      midiAccess.onstatechange = () => updateMidiDevices(midiAccess);
    });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (midiAccess) {
        midiAccess.onstatechange = null;
        midiAccess.inputs.forEach((input) => (input.onmidimessage = null));
      }
    };
  }, [handleNoteOn, handleNoteOff]);

  // --- 4. Assisted Practice Controls ---
  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setMidiFileName(file.name); // <-- NEW: Set the file name
    setGameState('idle');
    setPracticeMode('assisted');
    setKeyFeedback(new Map());
    activelyHeldAssistedNotes.current.clear();
    const arrayBuffer = await file.arrayBuffer();
    const midi = new Midi(arrayBuffer);
    let noteCounter = 0;
    const notes = midi.tracks
      .flatMap((track) => track.notes)
      .map((note) => {
        const keyData = KEYS.find((k) => k.midi === note.midi);
        if (!keyData) return null;
        const { whiteKeyWidth, blackKeyWidth } = dimensionsRef.current;
        const isBlackKey = keyData.type === 'black';
        return {
          id: noteCounter++,
          name: note.name,
          time: note.time,
          duration: note.duration,
          status: 'upcoming',
          y: 0,
          left: isBlackKey
            ? (keyData.whiteKeyIndex + 1) * whiteKeyWidth - blackKeyWidth / 2
            : keyData.whiteKeyIndex * whiteKeyWidth,
          width: isBlackKey ? blackKeyWidth : whiteKeyWidth,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
    songData.current = notes;
    setSongNotes(notes);
    setVisualSongNotes([]);
    setScore({ hits: 0, misses: 0, mistakes: 0 });
    e.target.value = '';
  };

  const startAssistedPractice = () => {
    if (!songData.current || songData.current.length === 0) return;
    setVisualSongNotes([]); // Clear any lingering notes from a "finished" state
    setScore({ hits: 0, misses: 0, mistakes: 0 });
    setKeyFeedback(new Map());
    activelyHeldAssistedNotes.current.clear();
    songData.current.forEach((n) => (n.status = 'upcoming'));
    gameStartTime.current = performance.now();
    totalPausedTime.current = 0;
    pauseStartTime.current = 0;
    setGameState('playing');
  };

  const handlePlayControls = () => {
    if (gameState === 'playing') {
      setGameState('paused');
      pauseStartTime.current = performance.now();
    } else if (gameState === 'paused') {
      const pausedDuration = performance.now() - pauseStartTime.current;
      totalPausedTime.current += pausedDuration;
      setGameState('playing');
    } else {
      // Handles 'idle' and 'finished' states
      startAssistedPractice();
    }
  };

  const getPlayButtonText = () => {
    if (gameState === 'finished') return 'Play Again';
    if (gameState === 'playing') return 'Pause';
    if (gameState === 'paused') return 'Resume';
    return 'Start Song';
  };

  const switchToFreePlay = () => {
    setPracticeMode('free');
    setGameState('idle');
    setSongNotes([]);
    setVisualSongNotes([]);
    activeFreePlayNotes.current.clear();
    activelyHeldAssistedNotes.current.clear();
    setKeyFeedback(new Map());
    setMidiFileName(null); // <-- NEW: Clear the file name
  };

  const getNoteColor = (status, keyType) => {
    if (status === 'hit') return '#10b981';
    if (status === 'missed' || status === 'early_release') return '#ef4444';
    if (status === 'upcoming' || !status) {
      return keyType === 'black' ? '#8b5cf6' : '#3b82f6';
    }
    return '#4b5563';
  };

  const getKeyClasses = (key) => {
    const feedback = keyFeedback.get(key.note);
    const isPressed = pressedKeys.has(key.note);
    if (key.type === 'white') {
      if (feedback === 'hit') return 'bg-green-300 translate-y-1 shadow-inner';
      if (feedback === 'mistake')
        return 'bg-red-300 translate-y-1 shadow-inner';
      if (isPressed) return 'bg-blue-300 translate-y-1 shadow-inner';
      return 'bg-white hover:bg-gray-100';
    }
    if (feedback === 'hit') return 'bg-green-500 h-[9.8rem]';
    if (feedback === 'mistake') return 'bg-red-500 h-[9.8rem]';
    if (isPressed) return 'bg-purple-600 h-[9.8rem]';
    return 'bg-gray-800 hover:bg-gray-700';
  };

  // --- 5. JSX Rendering ---
  return (
    <div
      ref={keyboardContainerRef}
      className="bg-gray-800 p-4 rounded-lg shadow-2xl w-full select-none"
    >
      <div className="flex justify-between items-center mb-4 text-white">
        <div className="flex gap-2">
          <button
            onClick={switchToFreePlay}
            className={`px-4 py-2 rounded text-sm font-bold transition-colors ${
              practiceMode === 'free'
                ? 'bg-blue-600'
                : 'bg-gray-600 hover:bg-gray-500'
            }`}
          >
            Free Practice
          </button>
          <label
            className={`px-4 py-2 rounded text-sm font-bold cursor-pointer transition-colors ${
              practiceMode === 'assisted'
                ? 'bg-purple-600'
                : 'bg-gray-600 hover:bg-gray-500'
            }`}
          >
            Load MIDI
            <input
              type="file"
              accept=".mid,.midi"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
          {practiceMode === 'assisted' && songNotes.length > 0 && (
            <button
              onClick={handlePlayControls}
              className={`px-4 py-2 rounded text-sm font-bold transition-colors w-28 ${
                gameState === 'playing'
                  ? 'bg-yellow-600 hover:bg-yellow-500' // Pause button
                  : 'bg-green-600 hover:bg-green-500' // Start, Resume, Play Again buttons
              }`}
            >
              {getPlayButtonText()}
            </button>
          )}
        </div>
        {practiceMode === 'assisted' && (
          <div className="flex gap-4 font-mono text-sm">
            <span>
              <span className="text-green-400">Hits:</span> {score.hits}
            </span>
            <span>
              <span className="text-red-400">Misses:</span> {score.misses}
            </span>
            <span>
              <span className="text-yellow-400">Mistakes:</span>{' '}
              {score.mistakes}
            </span>
          </div>
        )}
      </div>

      {/* --- NEW: Display for loaded MIDI file name --- */}
      {practiceMode === 'assisted' && midiFileName && (
        <div className="text-center text-gray-300 text-sm mb-2 font-mono truncate">
          Now Playing:{' '}
          <span className="font-bold text-purple-300">{midiFileName}</span>
        </div>
      )}

      <div
        className={`p-2 rounded-md text-center text-sm mb-2 transition-all duration-300 ${
          midiWarning
            ? 'bg-yellow-500 text-white font-bold'
            : 'bg-gray-700 text-gray-300 font-mono'
        }`}
      >
        {midiWarning || midiDeviceName}
      </div>

      <div
        className="relative rounded-t-lg bg-gray-900 overflow-hidden"
        style={{ height: `${ANIMATION_AREA_HEIGHT}px` }}
      >
        {practiceMode === 'assisted' && gameState === 'finished' && (
          <div className="absolute inset-0 bg-black bg-opacity-75 flex flex-col justify-center items-center text-white z-20">
            <h2 className="text-4xl font-bold mb-4">Song Finished!</h2>
            <div className="flex gap-6 font-mono text-lg">
              <span>
                <span className="text-green-400">Hits:</span> {score.hits}
              </span>
              <span>
                <span className="text-red-400">Misses:</span> {score.misses}
              </span>
              <span>
                <span className="text-yellow-400">Mistakes:</span>{' '}
                {score.mistakes}
              </span>
            </div>
          </div>
        )}

        {practiceMode === 'assisted' &&
          visualSongNotes.map((note) => {
            const keyData = KEYS.find((k) => k.note === note.name);
            if (!keyData) return null;
            const color = getNoteColor(note.status, keyData.type);
            const height = note.duration * NOTE_FALL_SPEED_PPS;
            return (
              <div
                key={`assist-${note.id}`}
                className="absolute rounded-md"
                style={{
                  left: `${note.left}px`,
                  width: `${note.width}px`,
                  height: `${height}px`,
                  top: 0,
                  transform: `translateY(${note.y - height}px)`,
                  backgroundColor: color,
                  opacity: note.status === 'finished' ? 0 : 1,
                  transition: 'background-color 200ms ease-in-out',
                  zIndex: keyData.type === 'black' ? 2 : 1,
                }}
              />
            );
          })}

        {practiceMode === 'free' &&
          visualSongNotes.map((note) => (
            <div
              key={`free-${note.id}`}
              ref={(el) => {
                const currentNote = activeFreePlayNotes.current.get(note.id);
                if (currentNote) currentNote.element = el;
              }}
              className="absolute bottom-0 rounded-md shadow-lg"
              style={{
                left: `${note.left}px`,
                width: `${note.width}px`,
                height: 0,
                opacity: 0.9,
                backgroundColor: note.color,
                border: `2px solid ${note.color}`,
                boxShadow: `0 0 20px ${note.color}`,
                background: `linear-gradient(180deg, ${note.color}, ${note.color}88)`,
                zIndex: 1,
              }}
            />
          ))}
      </div>

      <div className="relative flex w-full rounded-b-lg overflow-hidden mt-[-1px]">
        {WHITE_KEYS.map((key) => (
          <button
            key={key.note}
            onMouseDown={() => handleNoteOn(key)}
            onMouseUp={() => handleNoteOff(key)}
            onMouseLeave={() => handleNoteOff(key)}
            className={`relative border-r border-b border-gray-400 text-gray-800 flex items-end justify-center pb-2 transition-all duration-75 ease-in-out ${getKeyClasses(
              key
            )}`}
            style={{
              width: `${keyDimensions.whiteKeyWidth}px`,
              height: `${KEYBOARD_HEIGHT}px`,
            }}
          >
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
            className={`absolute top-0 rounded-b-md h-40 border border-t-0 border-gray-800 text-white flex items-end justify-center pb-2 transition-all duration-75 ease-in-out z-10 ${getKeyClasses(
              key
            )}`}
            style={{
              width: `${keyDimensions.blackKeyWidth}px`,
              left: `${
                (key.whiteKeyIndex + 1) * keyDimensions.whiteKeyWidth
              }px`,
              transform: 'translateX(-50%)',
            }}
          >
            <div className="flex flex-col items-center leading-none text-xs">
              <span>{key.note.slice(0, 1)}</span>
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
