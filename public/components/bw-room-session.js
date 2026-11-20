// Shared room-scoped browser persistence for poker, polls and Meeting Room.
// Saved characters live in the picker library; a chosen seat belongs to ONE room.
(function () {
  const memory = new Map();
  window.bwRoomSession = function (prefix, roomId) {
    const key = /^[a-z0-9]{6}$/.test(roomId || '') ? prefix + roomId : null;
    return {
      read() {
        if (!key) return null;
        for (const kind of ['localStorage', 'sessionStorage']) {
          try {
            const value = JSON.parse(window[kind].getItem(key) || 'null');
            if (value && typeof value === 'object' && !Array.isArray(value)) return value;
          } catch {}
        }
        return memory.get(key) || null;
      },
      write(value) {
        if (!key) return;
        memory.set(key, value);
        for (const kind of ['localStorage', 'sessionStorage']) {
          try { window[kind].setItem(key, JSON.stringify(value)); return; } catch {}
        }
      },
      clear() {
        if (!key) return;
        memory.delete(key);
        for (const kind of ['localStorage', 'sessionStorage']) {
          try { window[kind].removeItem(key); } catch {}
        }
      },
    };
  };
})();
