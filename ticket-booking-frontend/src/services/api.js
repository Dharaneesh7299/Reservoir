import { API_BASE_URL } from "../config/api";

/**
 * Fetch all available events and real-time inventory from backend.
 * @returns {Promise<Array<{ id: string, eventId: string, available: number, name: string, category: string, date: string, location: string, price: number }>>}
 */
export async function fetchEvents() {
  const response = await fetch(`${API_BASE_URL}/api/events?_t=${Date.now()}`, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch events: HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch current ticket inventory for a single given event ID.
 * @param {string|number} eventId
 * @returns {Promise<{ eventId: string, available: number }|null>}
 */
export async function fetchInventory(eventId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/events/${eventId}/inventory?_t=${Date.now()}`, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Admin action: Initialize or update ticket inventory for an event.
 * @param {Object} params
 * @param {string} params.eventId
 * @param {number} params.quantity
 * @param {Object} [params.metadata]
 * @param {string} params.token
 * @returns {Promise<{ message: string, eventId: string, available: number }>}
 */
export async function adminSetInventory({ eventId, quantity, metadata = {}, token }) {
  const response = await fetch(`${API_BASE_URL}/api/admin/events/${eventId}/inventory`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      quantity: Number(quantity),
      ...metadata,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Failed to set inventory: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Admin action: Delete/clear ticket inventory for an event.
 * @param {Object} params
 * @param {string} params.eventId
 * @param {string} params.token
 */
export async function adminDeleteInventory({ eventId, token }) {
  const response = await fetch(`${API_BASE_URL}/api/admin/events/${eventId}/inventory`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Failed to delete inventory: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Log in an existing user.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ message: string, token: string, user: { id: string, email: string, role: string } }>}
 */
export async function loginUser(email, password) {
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email: email.trim(), password }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Login failed: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Register a new user.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ message: string, user: { id: string, email: string, role: string } }>}
 */
export async function registerUser(email, password) {
  const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email: email.trim(), password }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Registration failed: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Fetch the currently authenticated user's profile.
 * @param {string} token
 * @returns {Promise<{ user: { id: string, email: string, role: string } }>}
 */
export async function getCurrentUser(token) {
  const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Failed to fetch profile: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Reserve tickets for an event.
 * @param {Object} params
 * @param {string|number} params.eventId
 * @param {number} params.quantity
 * @param {string} params.token
 * @param {string} params.idempotencyKey
 */
export async function reserveTickets({ eventId, quantity, token, idempotencyKey }) {
  const response = await fetch(`${API_BASE_URL}/api/reservations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ eventId: String(eventId), quantity: Number(quantity) }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Reservation failed: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Confirm an existing ticket reservation.
 * @param {string} reservationId
 * @param {string} token
 */
export async function confirmReservation(reservationId, token) {
  const response = await fetch(
    `${API_BASE_URL}/api/reservations/${reservationId}/confirm`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Confirmation failed: HTTP ${response.status}`);
  }

  return data;
}

/**
 * Fetch confirmed orders/bookings for the current user.
 * @param {string} token
 * @returns {Promise<Array>}
 */
export async function fetchUserOrders(token) {
  if (!token) return [];
  try {
    const response = await fetch(`${API_BASE_URL}/api/orders?_t=${Date.now()}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      return [];
    }

    return await response.json();
  } catch {
    return [];
  }
}

/**
 * Exchange a refresh token for a new session (the old refresh token is consumed).
 * @param {string} refreshToken
 * @returns {Promise<{ token: string, refreshToken: string, user: { id: string, email: string, role: string } }>}
 */
export async function refreshSession(refreshToken) {
  const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ refreshToken }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Refresh failed: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

/**
 * Revoke a refresh token on the server (best effort).
 * @param {string} refreshToken
 */
export async function logoutSession(refreshToken) {
  await fetch(`${API_BASE_URL}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    keepalive: true,
  });
}
