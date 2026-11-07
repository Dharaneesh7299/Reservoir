import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { AuthContext } from "./auth-context";
import {
  loginUser,
  registerUser,
  getCurrentUser,
  refreshSession,
  logoutSession,
} from "../services/api";

const STORAGE_TOKEN_KEY = "ticket_auth_token";
const STORAGE_USER_KEY = "ticket_auth_user";
const STORAGE_REFRESH_KEY = "ticket_auth_refresh";

// Refresh this long before the 15-minute access token expires.
const REFRESH_MARGIN_MS = 60 * 1000;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors (e.g. private browsing)
  }
}

function readStoredUser() {
  const stored = readStorage(STORAGE_USER_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// Read `exp` from a JWT without verifying it (the server verifies).
function tokenExpiryMs(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const { exp } = JSON.parse(atob(payload));
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => readStorage(STORAGE_TOKEN_KEY));
  const [user, setUser] = useState(readStoredUser);

  // The refresh token never drives rendering, so it lives in a ref.
  const refreshTokenRef = useRef(readStorage(STORAGE_REFRESH_KEY));
  const refreshInFlightRef = useRef(null);

  const [authModal, setAuthModal] = useState({
    isOpen: false,
    notice: "",
    defaultTab: "login",
  });

  // Write the access token last: other tabs react to that key changing
  // and then read the refresh token and user written just before it.
  const applySession = useCallback((data) => {
    refreshTokenRef.current = data.refreshToken || null;
    writeStorage(STORAGE_REFRESH_KEY, data.refreshToken || null);
    writeStorage(STORAGE_USER_KEY, JSON.stringify(data.user));
    writeStorage(STORAGE_TOKEN_KEY, data.token);
    setUser(data.user);
    setToken(data.token);
  }, []);

  const clearSession = useCallback(() => {
    refreshTokenRef.current = null;
    writeStorage(STORAGE_REFRESH_KEY, null);
    writeStorage(STORAGE_USER_KEY, null);
    writeStorage(STORAGE_TOKEN_KEY, null);
    setToken(null);
    setUser(null);
  }, []);

  // Adopt whatever session another tab has stored (used after a lost rotation race).
  const adoptStoredSession = useCallback(() => {
    const storedToken = readStorage(STORAGE_TOKEN_KEY);
    if (!storedToken) return false;
    refreshTokenRef.current = readStorage(STORAGE_REFRESH_KEY);
    setUser(readStoredUser());
    setToken(storedToken);
    return true;
  }, []);

  // Rotate the refresh token. Concurrent callers share one request.
  const refresh = useCallback(() => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    const run = async () => {
      // Prefer storage: another tab may already have rotated the token.
      const usedToken = readStorage(STORAGE_REFRESH_KEY) || refreshTokenRef.current;
      if (!usedToken) throw new Error("No refresh token");

      try {
        const data = await refreshSession(usedToken);
        applySession(data);
        return data.token;
      } catch (error) {
        // Another tab rotated first: its new token is now in storage.
        const latest = readStorage(STORAGE_REFRESH_KEY);
        if (latest && latest !== usedToken && adoptStoredSession()) {
          return readStorage(STORAGE_TOKEN_KEY);
        }
        throw error;
      }
    };

    const promise = run().finally(() => {
      refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = promise;
    return promise;
  }, [applySession, adoptStoredSession]);

  const logout = useCallback(() => {
    const refreshToken = refreshTokenRef.current || readStorage(STORAGE_REFRESH_KEY);
    if (refreshToken) {
      // Best effort: revoke server-side, but never block the UI on it.
      logoutSession(refreshToken).catch(() => {});
    }
    clearSession();
  }, [clearSession]);

  const login = useCallback(async (email, password) => {
    const data = await loginUser(email, password);
    applySession(data);
    return data;
  }, [applySession]);

  const register = useCallback(async (email, password) => {
    await registerUser(email, password);
    return await login(email, password);
  }, [login]);

  // Refresh shortly before the access token expires (immediately if it already has).
  useEffect(() => {
    if (!token) return;
    const expiresAt = tokenExpiryMs(token);
    if (!expiresAt) return;

    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_MARGIN_MS);
    const timer = setTimeout(() => {
      refresh().catch(() => clearSession());
    }, delay);

    return () => clearTimeout(timer);
  }, [token, refresh, clearSession]);

  // Verify the current token and pick up profile changes.
  useEffect(() => {
    if (!token) return;

    let isMounted = true;
    getCurrentUser(token)
      .then((data) => {
        if (isMounted && data?.user) {
          setUser((prev) => {
            const merged = {
              ...(prev || {}),
              ...data.user,
              email: data.user.email || prev?.email || "",
            };
            writeStorage(STORAGE_USER_KEY, JSON.stringify(merged));
            return merged;
          });
        }
      })
      .catch(() => {
        if (!isMounted) return;
        // The access token may simply have expired: try a refresh first.
        refresh().catch(() => {
          if (isMounted) clearSession();
        });
      });

    return () => {
      isMounted = false;
    };
  }, [token, refresh, clearSession]);

  // Keep tabs in sync: login, refresh and logout in one tab apply to all.
  useEffect(() => {
    function handleStorage(event) {
      if (event.key !== STORAGE_TOKEN_KEY) return;
      if (event.newValue) {
        refreshTokenRef.current = readStorage(STORAGE_REFRESH_KEY);
        setUser(readStoredUser());
        setToken(event.newValue);
      } else {
        refreshTokenRef.current = null;
        setToken(null);
        setUser(null);
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const openAuthModal = useCallback((notice = "", defaultTab = "login") => {
    setAuthModal({
      isOpen: true,
      notice,
      defaultTab,
    });
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModal((prev) => ({ ...prev, isOpen: false, notice: "" }));
  }, []);

  const value = useMemo(
    () => ({
      token,
      user,
      isAuthenticated: Boolean(token && user),
      isAdmin: user?.role === "ADMIN",
      login,
      register,
      logout,
      authModal,
      openAuthModal,
      closeAuthModal,
    }),
    [token, user, login, register, logout, authModal, openAuthModal, closeAuthModal]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthProvider;
