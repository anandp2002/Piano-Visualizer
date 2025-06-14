import React from 'react';

import PianoKeyboard from './components/PianoKeyboard';

function App() {
  return (
    <div className="w-full flex flex-col h-screen bg-gray-900 items-center justify-center p-4">
      <div className="w-full  overflow-x-auto">
        <PianoKeyboard />
      </div>
    </div>
  );
}

export default App;
