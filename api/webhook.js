// Sanath Superline Chatbot - Dialogflow Webhook Fulfillment (Vercel version)
// This file must live at: api/webhook.js  (Vercel turns files in /api into live endpoints)
// Your deployed URL for this file will be: https://YOUR-PROJECT.vercel.app/api/webhook

const { WebhookClient } = require('dialogflow-fulfillment');
const routesData = require('../routes-data.json');

function getCityData(cityParam) {
  if (!cityParam) return null;
  const key = String(cityParam).toLowerCase().trim();
  return routesData[key] || null;
}

function listKnownCities() {
  return Object.keys(routesData)
    .map(c => c.charAt(0).toUpperCase() + c.slice(1))
    .join(', ');
}

function routeEnquiry(agent) {
  const destination = agent.parameters.destination;
  const origin = agent.parameters.origin || 'Colombo';
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have route information for "${destination}" yet. We currently cover Colombo to: ${listKnownCities()}.`);
    return;
  }

  const types = data.busTypes.map(b => b.type).join(', ');
  agent.add(
    `Yes! Sanath Superline runs buses from ${origin} to ${destination}. ` +
    `Distance: ${data.distanceKm} km, journey time: about ${data.durationHours} hours via ${data.roadType}. ` +
    `Bus types available: ${types}. Would you like the timetable or fares?`
  );
}

function timetableEnquiry(agent) {
  const destination = agent.parameters.destination;
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have timetable information for "${destination}". We cover: ${listKnownCities()}.`);
    return;
  }

  let response = `Departure times from Colombo to ${destination}: `;
  response += data.busTypes
    .map(bus => `${bus.type} (${bus.departureTimes.join(', ')})`)
    .join('; ');
  agent.add(response);
}

function busTypeEnquiry(agent) {
  const destination = agent.parameters.destination;
  const busType = agent.parameters.busType;
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have information for "${destination}". We cover: ${listKnownCities()}.`);
    return;
  }

  if (busType) {
    const match = data.busTypes.find(
      b => b.type.toLowerCase() === String(busType).toLowerCase()
    );
    if (match) {
      agent.add(
        `Yes, we run ${match.type} buses to ${destination}, departing at ${match.departureTimes.join(', ')}. Fare: Rs. ${match.fare}.`
      );
    } else {
      agent.add(
        `Sorry, we don't currently run ${busType} buses to ${destination}. Available types: ${data.busTypes.map(b => b.type).join(', ')}.`
      );
    }
  } else {
    agent.add(`Available bus types to ${destination}: ${data.busTypes.map(b => b.type).join(', ')}.`);
  }
}

function roadTypeEnquiry(agent) {
  const destination = agent.parameters.destination;
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have road information for "${destination}". We cover: ${listKnownCities()}.`);
    return;
  }
  agent.add(`Buses to ${destination} travel via: ${data.roadType}.`);
}

function fareEnquiry(agent) {
  const destination = agent.parameters.destination;
  const busType = agent.parameters.busType;
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have fare information for "${destination}". We cover: ${listKnownCities()}.`);
    return;
  }

  if (busType) {
    const match = data.busTypes.find(
      b => b.type.toLowerCase() === String(busType).toLowerCase()
    );
    if (match) {
      agent.add(`The fare for ${match.type} to ${destination} is Rs. ${match.fare}.`);
      return;
    }
  }

  const response = data.busTypes.map(b => `${b.type}: Rs. ${b.fare}`).join(', ');
  agent.add(`Fares to ${destination} - ${response}.`);
}

function fallback(agent) {
  agent.add(
    `Sorry, I didn't quite catch that. You can ask me about routes, timetables, bus types (Normal, Semi-Luxury, Luxury), fares, or road type (Expressway or Normal Road) for any of our destinations: ${listKnownCities()}.`
  );
}

// Vercel serverless function entry point
module.exports = (req, res) => {
  // Simple health check: visiting the URL directly in a browser sends a GET request
  if (req.method === 'GET') {
    res.status(200).send('Sanath Superline webhook is running.');
    return;
  }

  const agent = new WebhookClient({ request: req, response: res });

  const intentMap = new Map();
  intentMap.set('route.enquiry', routeEnquiry);
  intentMap.set('timetable.enquiry', timetableEnquiry);
  intentMap.set('busType.enquiry', busTypeEnquiry);
  intentMap.set('roadType.enquiry', roadTypeEnquiry);
  intentMap.set('fare.enquiry', fareEnquiry);
  intentMap.set('timetable.followup', timetableEnquiry);
  intentMap.set('Default Fallback Intent', fallback);

  agent.handleRequest(intentMap);
};
