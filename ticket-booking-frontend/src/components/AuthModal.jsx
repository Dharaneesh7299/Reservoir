import { useState, useEffect } from "react";
import { useAuth } from "../context/useAuth";
import "./AuthModal.css";

function AuthModal() {
  const { authModal, closeAuthModal, login, register } = useAuth();
  const [tab, setTab] = useState(authModal.defaultTab || "login");
  const [prevIsOpen, setPrevIsOpen] = useState(authModal.isOpen);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Synchronize tab and reset errors when modal opens without cascading effect
  if (authModal.isOpen !== prevIsOpen) {
    setPrevIsOpen(authModal.isOpen);
    if (authModal.isOpen) {
      setTab(authModal.defaultTab || "login");
      setError("");
    }
  }

  // Handle ESC key to dismiss modal
  useEffect(() => {
    if (!authModal.isOpen) return;

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        closeAuthModal();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [authModal.isOpen, closeAuthModal]);

  if (!authModal.isOpen) {
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Please fill in all fields.");
      return;
    }

    if (tab === "register" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      if (tab === "login") {
        await login(email, password);
      } else {
        await register(email, password);
      }
      closeAuthModal();
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(err.message || "An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function switchTab(newTab) {
    setTab(newTab);
    setError("");
  }

  return (
    <div className="auth-overlay" onClick={closeAuthModal}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button
          className="auth-close-btn"
          onClick={closeAuthModal}
          aria-label="Close authentication modal"
        >
          &times;
        </button>

        {/* Keyed by tab so the heading fades when switching Sign In / Register. */}
        <div className="auth-header" key={tab}>
          <h2 className="auth-title">
            {tab === "login" ? "Welcome back" : "Create an account"}
          </h2>
          <p className="auth-subtitle">
            {tab === "login"
              ? "Sign in to manage and confirm your event tickets."
              : "Register to reserve and purchase live event tickets."}
          </p>
        </div>

        {authModal.notice && (
          <div className="auth-notice-banner">
            <span>ℹ️</span> {authModal.notice}
          </div>
        )}

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "login"}
            className={`auth-tab ${tab === "login" ? "active" : ""}`}
            onClick={() => switchTab("login")}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "register"}
            className={`auth-tab ${tab === "register" ? "active" : ""}`}
            onClick={() => switchTab("register")}
          >
            Register
          </button>
        </div>

        {error && (
          <div className="auth-error-banner" role="alert">
            <span>⚠️</span> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label htmlFor="auth-email">Email Address</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              required
              autoFocus
              autoComplete="email"
            />
          </div>

          <div className="auth-field">
            <div className="auth-field-header">
              <label htmlFor="auth-password">Password</label>
              {tab === "register" && (
                <span className="auth-field-hint">Min 8 characters</span>
              )}
            </div>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={tab === "register" ? 8 : 1}
              autoComplete={tab === "login" ? "current-password" : "new-password"}
            />
          </div>

          <button
            type="submit"
            className="auth-submit-btn"
            disabled={loading}
          >
            {loading ? (
              <span>{tab === "login" ? "Signing In..." : "Creating Account..."}</span>
            ) : (
              <span>{tab === "login" ? "Sign In" : "Create Account"}</span>
            )}
          </button>
        </form>

        <div className="auth-footer">
          {tab === "login" ? (
            <p>
              Don't have an account?{" "}
              <button
                type="button"
                className="auth-link-btn"
                onClick={() => switchTab("register")}
              >
                Sign up
              </button>
            </p>
          ) : (
            <p>
              Already have an account?{" "}
              <button
                type="button"
                className="auth-link-btn"
                onClick={() => switchTab("login")}
              >
                Sign in
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default AuthModal;
