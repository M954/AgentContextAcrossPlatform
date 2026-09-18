'use strict';

// Keep the normalized wire timestamp valid without inventing a historical time.
// The epoch sentinel is always paired with timestampBasis: unavailable.
function timestampFields(value) {
  if (value === undefined || value === null) {
    return { timestamp: '1970-01-01T00:00:00.000Z', timestampBasis: 'unavailable' };
  }
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) {
    throw new Error('Invalid conversation timestamp; export valid source records');
  }
  return { timestamp: new Date(time).toISOString(), timestampBasis: 'source' };
}

function definedFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

module.exports = { timestampFields, definedFields };
