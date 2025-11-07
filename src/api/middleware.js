export const allowOnlyLocalhost = (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  
  // Check for localhost (IPv4, IPv6 loopback, and IPv4-mapped IPv6)
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    console.warn(`[API] Rejected request from non-localhost IP: ${ip}`);
    return res.status(403).json({ error: "Forbidden: This endpoint is only accessible from localhost." });
  }
  next();
};