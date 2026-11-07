import { useState, useEffect, useCallback, useRef } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { AuthProvider } from "./context/AuthProvider";
import { useAuth } from "./context/useAuth";
import AuthModal from "./components/AuthModal";
import AdminAddTicketsModal from "./components/AdminAddTicketsModal";
import Events from "./pages/Events";
import Bookings from "./pages/Bookings";
import { fetchEvents, fetchUserOrders, reserveTickets, confirmReservation } from "./services/api";
import "./App.css";

function AppContent() {
  const { user, isAuthenticated, isAdmin, logout, openAuthModal, token } = useAuth();
  const location = useLocation();

  const [events, setEvents] = useState([]);
  const [isEventsLoading, setIsEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);

  const [selectedEvent, setSelectedEvent] = useState(null);
  const [ticketQuantity, setTicketQuantity] = useState(1);
  const [isBookingSubmitting, setIsBookingSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState("");
  const [toastMessage, setToastMessage] = useState("");

  const userEmail = user?.email || "";
  const userInitial = (userEmail ? userEmail[0] : (user?.role ? user.role[0] : "U")).toUpperCase();
  const userDisplay = userEmail || (user?.id ? `User #${user.id.slice(0, 6)}` : "My Account");

  const currentUserId = isAuthenticated && user?.id ? user.id : null;

  // User-isolated bookings map: { [userId]: Array }
  const [userBookingsMap, setUserBookingsMap] = useState(() => {
    try {
      localStorage.removeItem("ticket_bookings_history");
    } catch {}
    return {};
  });

  // Current active user's bookings: strictly empty array when logged out
  const bookings = currentUserId
    ? (userBookingsMap[currentUserId] || (() => {
        try {
          const stored = localStorage.getItem(`ticket_bookings_${currentUserId}`);
          return stored ? JSON.parse(stored) : [];
        } catch {
          return [];
        }
      })())
    : [];

  const handleRefreshOrders = useCallback(async () => {
    if (!currentUserId || !token) return;
    try {
      const serverOrders = await fetchUserOrders(token);
      if (Array.isArray(serverOrders)) {
        setUserBookingsMap((prev) => {
          let existing = prev[currentUserId];
          if (!existing) {
            try {
              const s = localStorage.getItem(`ticket_bookings_${currentUserId}`);
              existing = s ? JSON.parse(s) : [];
            } catch {
              existing = [];
            }
          }

          const map = new Map();
          for (const item of existing) {
            const key = item.bookingId || item.reservationId || item.id;
            // Drop client-only bookings left in the cache by the removed demo mode.
            if (key && !String(key).startsWith("demo-")) map.set(key, item);
          }
          for (const order of serverOrders) {
            const key = order.bookingId || order.reservationId || order.id;
            if (key) {
              const current = map.get(key);
              if (current && current.status === "CONFIRMED" && order.status === "PENDING") {
                map.set(key, { ...order, status: "CONFIRMED" });
              } else {
                map.set(key, order);
              }
            }
          }
          const merged = Array.from(map.values()).sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
          );

          try {
            localStorage.setItem(`ticket_bookings_${currentUserId}`, JSON.stringify(merged));
          } catch {}

          return { ...prev, [currentUserId]: merged };
        });
      }
    } catch {}
  }, [currentUserId, token]);

  // Synchronize bookings strictly for the active authenticated user
  useEffect(() => {
    handleRefreshOrders();
  }, [handleRefreshOrders]);

  // One timer at a time, so a new toast isn't cleared early by an older one
  // (the CSS countdown bar assumes a full 4 s).
  const toastTimerRef = useRef(null);

  function showToast(msg) {
    clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage("");
    }, 4000);
  }

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  const loadLiveEvents = useCallback(async () => {
    try {
      const data = await fetchEvents();
      setEvents(Array.isArray(data) ? data : []);
      setEventsError("");
    } catch (err) {
      setEventsError(err.message || "Failed to load live event tickets");
    } finally {
      setIsEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    fetchEvents()
      .then((data) => {
        if (!ignore) {
          setEvents(Array.isArray(data) ? data : []);
          setEventsError("");
        }
      })
      .catch((err) => {
        if (!ignore) {
          setEventsError(err.message || "Failed to load live event tickets");
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsEventsLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  function handleOpenBooking(event) {
    setSelectedEvent(event);
    setTicketQuantity(1);
    setBookingError("");

    if (!isAuthenticated) {
      openAuthModal("Please sign in or register to complete your ticket booking.");
    }
  }

  function handleEditEvent(event) {
    setEditingEvent(event);
    setIsAdminModalOpen(true);
  }

  async function handleConfirmBooking() {
    if (!isAuthenticated) {
      openAuthModal("Please sign in first to confirm this reservation.");
      return;
    }

    setIsBookingSubmitting(true);
    setBookingError("");

    const idempotencyKey = `idemp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    try {
      // 1. Reserve tickets with backend
      const reserveData = await reserveTickets({
        eventId: selectedEvent.id || selectedEvent.eventId,
        quantity: ticketQuantity,
        token,
        idempotencyKey,
      });

      const reservationId =
        reserveData?.reservation?.reservationId ||
        reserveData?.reservation?.id ||
        reserveData?.reservationId;

      if (!reservationId) {
        throw new Error("Backend did not return a valid reservation ID.");
      }

      // 2. Confirm reservation with backend
      await confirmReservation(reservationId, token);

      // 3. Save confirmed booking strictly mapped to current user
      const newBooking = {
        bookingId: reservationId,
        reservationId,
        userId: user.id,
        event: selectedEvent,
        quantity: ticketQuantity,
        totalPrice: (selectedEvent.price || 0) * ticketQuantity,
        status: "CONFIRMED",
        createdAt: new Date().toISOString(),
      };

      setUserBookingsMap((prev) => {
        const userList = prev[user.id] || bookings;
        const updated = [newBooking, ...userList.filter((b) => (b.bookingId || b.reservationId) !== reservationId)];
        if (user?.id) {
          try {
            localStorage.setItem(`ticket_bookings_${user.id}`, JSON.stringify(updated));
          } catch {}
        }
        return { ...prev, [user.id]: updated };
      });
      setSelectedEvent(null);
      showToast(`🎉 Booking confirmed! Reservation ID: ${reservationId.substring(0, 8)}...`);

      // 4. Refresh live inventory counts & server orders
      await loadLiveEvents();
      await handleRefreshOrders();
    } catch (err) {
      setBookingError(err.message || "Failed to confirm reservation with backend.");
    } finally {
      setIsBookingSubmitting(false);
    }
  }

  async function handleConfirmReservation(reservationId) {
    if (!token) return;
    try {
      showToast("⏳ Confirming reservation with server...");
      await confirmReservation(reservationId, token);
      showToast("🎉 Reservation successfully confirmed!");
      await handleRefreshOrders();
      await loadLiveEvents();
    } catch (err) {
      showToast(`❌ Confirmation failed: ${err.message || "Please try again"}`);
    }
  }

  function handleLogout() {
    // `bookings` is derived from the current user ID, so it clears itself on logout.
    logout();
  }

  return (
    <div className="app-container">
      <AuthModal />

      <AdminAddTicketsModal
        key={editingEvent ? (editingEvent.id || editingEvent.eventId) : "new"}
        isOpen={isAdminModalOpen}
        onClose={() => {
          setIsAdminModalOpen(false);
          setEditingEvent(null);
        }}
        onInventoryUpdated={(eventId, qty, action) => {
          loadLiveEvents();
          if (action === "deleted") {
            showToast(`🗑️ Event #${eventId} deleted from inventory!`);
          } else {
            showToast(`✅ Tickets updated for #${eventId} (${qty} available)!`);
          }
        }}
        existingEvents={events}
        initialEvent={editingEvent}
      />

      {toastMessage && (
        <div className="toast-notification" role="status" key={toastMessage}>
          <span>{toastMessage}</span>
          <button
            type="button"
            className="toast-close-btn"
            onClick={() => setToastMessage("")}
          >
            &times;
          </button>
        </div>
      )}

      {/* Minimal White Navigation */}
      <nav className="navbar">
        <Link to="/" className="brand" aria-label="Reservoir Home">
          <div className="brand-logo">🎟️</div>
          <h2>Reservoir</h2>
        </Link>

        <div className="nav-links">
          <Link
            to="/"
            className={`nav-link ${location.pathname === "/" ? "active" : ""}`}
          >
            Events
          </Link>
          <Link
            to="/bookings"
            className={`nav-link ${location.pathname === "/bookings" ? "active" : ""}`}
          >
            My Bookings
            {isAuthenticated && bookings.length > 0 && (
              <span className="nav-badge">{bookings.length}</span>
            )}
          </Link>

          <div className="nav-auth-section">
            {isAuthenticated ? (
              <div className="user-profile-menu">
                {isAdmin && (
                  <button
                    type="button"
                    className="admin-nav-btn"
                    onClick={() => {
                      setEditingEvent(null);
                      setIsAdminModalOpen(true);
                    }}
                    title="Add or update tickets in backend inventory"
                  >
                    <span className="admin-btn-icon">+</span>
                    <span>Add Tickets</span>
                  </button>
                )}
                <div className="user-chip" title={userDisplay}>
                  <span className="user-avatar-circle">
                    {userInitial}
                  </span>
                  <span className="user-email-text">{userDisplay}</span>
                  {isAdmin && <span className="admin-role-badge">ADMIN</span>}
                </div>
                <button
                  type="button"
                  className="sign-out-btn"
                  onClick={handleLogout}
                  aria-label="Sign out"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="sign-in-btn"
                onClick={() => openAuthModal()}
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Routes (keyed by path so each page plays its entrance transition) */}
      <div className="page-transition" key={location.pathname}>
      <Routes>
        <Route
          path="/"
          element={
            <Events
              events={events}
              loading={isEventsLoading}
              error={eventsError}
              onBook={handleOpenBooking}
              onOpenAdmin={() => {
                setEditingEvent(null);
                setIsAdminModalOpen(true);
              }}
              onEdit={handleEditEvent}
            />
          }
        />
        <Route
          path="/bookings"
          element={
            <Bookings
              bookings={bookings}
              onConfirmReservation={handleConfirmReservation}
              onRefreshOrders={handleRefreshOrders}
            />
          }
        />
      </Routes>
      </div>

      {/* Booking Confirmation Modal */}
      {selectedEvent && (
        <div className="booking-modal" onClick={() => setSelectedEvent(null)}>
          <div
            className="booking-content"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-modal-title"
          >
            <button
              className="close-button"
              onClick={() => setSelectedEvent(null)}
              aria-label="Close modal"
            >
              &times;
            </button>

            <div className="booking-modal-header">
              <span className="booking-modal-kicker">{selectedEvent.category}</span>
              <h2 id="booking-modal-title">Confirm Ticket Reservation</h2>
            </div>

            <div className="booking-summary-card">
              <h3 className="event-name-display">{selectedEvent.name}</h3>
              <div className="summary-meta-grid">
                <div>
                  <small>Date</small>
                  <p>📅 {selectedEvent.date}</p>
                </div>
                <div>
                  <small>Location</small>
                  <p>📍 {selectedEvent.location}</p>
                </div>
                <div>
                  <small>Price per ticket</small>
                  <p>₹{Number(selectedEvent.price || 0).toLocaleString("en-IN")}</p>
                </div>
                <div>
                  <small>Availability</small>
                  <p>{selectedEvent.available} available</p>
                </div>
              </div>

              {/* Quantity Selector */}
              <div className="quantity-control-row">
                <label htmlFor="ticket-quantity">Tickets Quantity:</label>
                <div className="quantity-stepper">
                  <button
                    type="button"
                    onClick={() => setTicketQuantity((q) => Math.max(1, q - 1))}
                    disabled={ticketQuantity <= 1 || isBookingSubmitting}
                    aria-label="Decrease quantity"
                  >
                    -
                  </button>
                  <span className="quantity-value" key={ticketQuantity}>{ticketQuantity}</span>
                  <button
                    type="button"
                    onClick={() => setTicketQuantity((q) => Math.min(10, q + 1))}
                    disabled={ticketQuantity >= 10 || isBookingSubmitting}
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Price Breakdown */}
              <div className="booking-price-summary">
                <span>Total Amount:</span>
                <strong className="total-amount" key={ticketQuantity}>
                  ₹{((selectedEvent.price || 0) * ticketQuantity).toLocaleString("en-IN")}
                </strong>
              </div>
            </div>

            {/* Error Display */}
            {bookingError && (
              <div className="booking-error-alert" role="alert">
                <p>⚠️ <strong>Backend Error:</strong> {bookingError}</p>
                {bookingError.toLowerCase().includes("not been initialized") && (
                  <p className="error-tip">
                    Note: Backend inventory must be initialized by admin via <code>PUT /api/admin/events/{selectedEvent.id || selectedEvent.eventId}/inventory</code>.
                  </p>
                )}
              </div>
            )}

            {/* Actions */}
            {!isAuthenticated ? (
              <div className="modal-auth-prompt">
                <p>You need to sign in to confirm this reservation with the backend service.</p>
                <button
                  type="button"
                  className="confirm-button"
                  onClick={() => openAuthModal("Sign in to confirm your ticket reservation.")}
                >
                  Sign In to Reserve
                </button>
              </div>
            ) : (
              <div className="modal-actions">
                <div className="user-order-tag">
                  Reserving for: <strong>{userDisplay}</strong>
                </div>
                <button
                  type="button"
                  className="confirm-button"
                  onClick={handleConfirmBooking}
                  disabled={isBookingSubmitting}
                >
                  {isBookingSubmitting ? "Reserving Tickets..." : "Confirm & Pay"}
                </button>
                <button
                  type="button"
                  className="cancel-button"
                  onClick={() => setSelectedEvent(null)}
                  disabled={isBookingSubmitting}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
