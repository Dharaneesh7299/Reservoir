import { Link } from "react-router-dom";
import { useAuth } from "../context/useAuth";

function Bookings({ bookings, onConfirmReservation, onRefreshOrders }) {
  const { isAuthenticated, user, openAuthModal } = useAuth();

  return (
    <main className="main-content">
      <div className="section-heading">
        <div>
          <h2>My Bookings</h2>
          {isAuthenticated && (
            <span className="user-email-subtitle">
              Logged in as {user?.email || (user?.id ? `User #${user.id.slice(0, 6)}` : "My Account")}
            </span>
          )}
        </div>
        {isAuthenticated && (
          <div className="bookings-heading-actions">
            {onRefreshOrders && (
              <button
                type="button"
                className="refresh-orders-btn"
                onClick={onRefreshOrders}
                title="Sync bookings with server"
              >
<span className="refresh-icon" aria-hidden="true">🔄</span> Refresh
              </button>
            )}
            <span className="count-pill">{bookings.length} {bookings.length === 1 ? "booking" : "bookings"}</span>
          </div>
        )}
      </div>

      {!isAuthenticated ? (
        <div className="auth-prompt-card">
          <div className="auth-prompt-icon">🔐</div>
          <h3>Sign in to view your tickets</h3>
          <p>Please sign in with your account to access your booked reservations.</p>
          <button
            type="button"
            className="primary-btn"
            onClick={() => openAuthModal("Sign in to see your confirmed bookings.")}
          >
            Sign In to View Bookings
          </button>
        </div>
      ) : bookings.length === 0 ? (
        <div className="empty-bookings">
          <div className="empty-icon">🎟️</div>
          <h3>No bookings found for this account</h3>
          <p>You haven't reserved any tickets yet. Explore upcoming events to get started.</p>
          <Link to="/" className="browse-events-btn">
            Browse Events
          </Link>
        </div>
      ) : (
        <div className="booking-list">
          {bookings.map((booking, index) => {
            const quantity = booking.quantity || 1;
            const eventPrice = booking.event?.price || 0;
            const totalPrice = booking.totalPrice || (eventPrice * quantity);
            const status = (booking.status || "CONFIRMED").toUpperCase();
            const isConfirmed = status.includes("CONFIRMED");
            const isPending = status === "PENDING";
            const isExpired = status === "EXPIRED";

            return (
              <div
                className="booking-card"
                key={booking.bookingId || booking.reservationId || booking.id}
                style={{ "--i": Math.min(index, 10) }}
              >
                <div className="booking-card-left">
                  <div className="booking-card-header">
                    <span className="booking-category">{booking.event?.category || "Live Event"}</span>
                    <span className="booking-id-tag">ID: {booking.bookingId || booking.reservationId || booking.id}</span>
                  </div>

                  <h3 className="booking-event-name">{booking.event?.name || booking.eventId}</h3>

                  <div className="booking-meta">
                    <p>📅 {booking.event?.date || "Upcoming"}</p>
                    <p>📍 {booking.event?.location || "Venue TBA"}</p>
                    <p>🎟️ {quantity} {quantity === 1 ? "ticket" : "tickets"}</p>
                  </div>
                </div>

                <div className="booking-card-right">
                  <div className="booking-status-wrapper">
                    <span
                      className={`booking-status ${
                        isConfirmed ? "status-confirmed" : isPending ? "status-pending" : "status-expired"
                      }`}
                    >
                      {isConfirmed && "✓ CONFIRMED"}
                      {isPending && "⏳ PENDING"}
                      {isExpired && "✕ EXPIRED"}
                      {!isConfirmed && !isPending && !isExpired && status}
                    </span>

                    {isPending && onConfirmReservation && (
                      <button
                        type="button"
                        className="confirm-pending-btn"
                        onClick={() => onConfirmReservation(booking.bookingId || booking.reservationId || booking.id)}
                      >
                        ⚡ Confirm Now
                      </button>
                    )}
                  </div>

                  <div className="booking-price-block">
                    <small>Total Paid</small>
                    <h3>₹{totalPrice.toLocaleString("en-IN")}</h3>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

export default Bookings;
