import { useAuth } from "../context/useAuth";
import "./EventCard.css";

function EventCard({ event, onBook, onEdit, index = 0 }) {
  const { isAdmin } = useAuth();
  const isSoldOut = typeof event.available === "number" && event.available <= 0;

  return (
    // --i drives the staggered entrance delay in EventCard.css.
    <div className={`event-card ${isSoldOut ? "sold-out" : ""}`} style={{ "--i": index }}>
      <div className="event-card-header">
        <div className="event-category-chip">
          <span className="category-icon">{event.icon || "🎟️"}</span>
          <span className="category-name">{event.category}</span>
        </div>
        <div className="card-header-right">
          {isAdmin && onEdit && (
            <button
              type="button"
              className="admin-edit-chip-btn"
              onClick={() => onEdit(event)}
              title="Edit or update tickets for this event"
            >
              ✏️ Edit
            </button>
          )}
          <span className="event-id-badge" title="Backend Event ID">
            #{event.id}
          </span>
        </div>
      </div>

      <div className="event-info">
        <h3 className="event-title">{event.name}</h3>

        <div className="event-meta">
          <p className="event-meta-item">
            <span className="meta-icon">📅</span>
            <span>{event.date}</span>
          </p>
          <p className="event-meta-item">
            <span className="meta-icon">📍</span>
            <span>{event.location}</span>
          </p>
          {event.type && (
            <p className="event-meta-item">
              <span className="meta-icon">🎫</span>
              <span>{event.type}</span>
            </p>
          )}
        </div>

        <div className="event-bottom">
          <div className="event-pricing">
            <span className="event-price">₹{event.price.toLocaleString("en-IN")}</span>
            <small className={`event-availability ${isSoldOut ? "empty" : ""}`}>
              {isSoldOut ? "Sold Out" : `${event.available} tickets available`}
            </small>
          </div>

          <button
            type="button"
            className="book-btn"
            onClick={() => onBook(event)}
            disabled={isSoldOut}
          >
            {isSoldOut ? "Sold Out" : "Book Tickets"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EventCard;
