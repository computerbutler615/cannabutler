try {
const http = require('http');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const paypal = require('@paypal/checkout-server-sdk');
const stripe = require('stripe')(process.env.STRIPE_KEY);
const uuid = require('uuid'); 
const jwt = require('jsonwebtoken');

const app = express();

// middleware config
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Set EJS as the template engine
app.set('view engine', 'ejs');

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI);
mongoose.connection.on('error', err => {
    console.error('MongoDB connection error: ' + err);
    process.exit(-1);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

// import and execute routers (other files)
const administratorManagementRouter = require('./administrator-management');
const productManagementRouter = require('./product-management');
const vendorManagementRouter = require('./vendor-management');
const userManagementRouter = require('./user-management');
const driverManagementRouter = require('./driver-management');
app.use(administratorManagementRouter);
app.use(vendorManagementRouter);
app.use(productManagementRouter);
app.use(userManagementRouter);
app.use(driverManagementRouter);

// import model files
const User = require('./models/user'); 

// extract user or vendor Id and provide it to other functions
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) {
      console.log('Authentication token is missing');
      return res.sendStatus(401);
  }

  jwt.verify(token, process.env.SESSION_SECRET, (err, decoded) => {
      if (err) {
          console.log('Token verification failed:', err.message);
          return res.sendStatus(403);
      }

      // Ensure that the decoded token includes the role
      if (!decoded.role) {
          console.log('Role is missing in the token');
          return res.sendStatus(403);
      }

      if (decoded.role === 'vendor') {
          req.vendorId = decoded.vendorId;
          // console.log('Token verified for vendor. Vendor ID:', req.vendorId);
      } else if (decoded.role === 'user') {
          req.userId = decoded.userId;
          // console.log('Token verified for user. User ID:', req.userId);
      } else {
          console.log('Invalid role in token:', decoded.role);
          return res.sendStatus(403);
      }

      next();
  });
}

// Route to create a Stripe payment
app.post('/api/create-stripe-payment', express.json(), authenticateToken, async (req, res) => {
  const userId = req.userId; 
  const totalAmount = req.body.total;
  const products = req.body.products; // Retrieve products from the request

  if (!totalAmount || !products) {
    console.log('Total amount and products are required');
    return res.status(400).send({ message: 'Total amount and products are required' });
  }

  const orderId = uuid.v4();

  try {
    // Convert totalAmount to cents for Stripe
    const amountInCents = Math.round(totalAmount * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      metadata: {
        userId: userId,
        orderId: orderId,
      },
    });    

    await User.findByIdAndUpdate(userId, { $push: { orders: { orderId: orderId, totalAmount: totalAmount, currency: 'USD', date: new Date(), status: 'Created', products: products } } });

    res.json({ clientSecret: paymentIntent.client_secret });
    
  } catch (err) {
    console.error('Error creating Stripe payment:', err);
    res.status(500).send({ message: 'Error creating Stripe payment', error: err.toString() });
  }
});

// route to update Stripe order status in database
app.post('/api/stripe-payment-success-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_ENDPOINT_SECRET);
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

    // Handle the event
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const userId = paymentIntent.metadata.userId; // Ensure you pass userId in metadata when creating the PaymentIntent
      const orderId = paymentIntent.metadata.orderId; // Ensure orderId is also passed in metadata
  
      // Call the function to update order status to 'Paid'
      try {
        await User.updateOne(
          { _id: userId, 'orders.orderId': orderId },
          { $set: { 'orders.$.status': 'Paid' } }
        );
      } catch (error) {
        console.error('Error updating order status to Paid:', error);
      }
  
      res.json({received: true});
    } else {
      console.log(`Unhandled event type ${event.type}`);
      res.json({received: true});
    }
  });
  
// Configure PayPal environment with your credentials
const environment = new paypal.core.SandboxEnvironment(
  process.env.PAYPAL_CLIENT_ID, 
  process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(environment);

// Route to create a PayPal payment
app.post('/api/create-paypal-payment', express.json(), authenticateToken, async (req, res) => {
  const userId = req.userId; 
  const totalAmount = req.body.total;
  const products = req.body.products; // Retrieve products from the request

  if (!totalAmount || !products) {
    console.log('Total amount and products are required');
    return res.status(400).send({ message: 'Total amount and products are required' });
  }

  const orderId = uuid.v4();

  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: orderId,
      amount: {
        currency_code: 'USD',
        value: totalAmount
      },
    }]
  });

  try {
    const order = await paypalClient.execute(request);
    const approvalUrl = order.result.links.find(link => link.rel === 'approve').href;
    await User.findByIdAndUpdate(userId, { $push: { orders: { orderId: orderId, totalAmount: totalAmount, currency: 'USD', date: new Date(), status: 'Created', products: products } } });
    res.json({ id: order.result.id, links: order.result.links, orderId: orderId, approvalUrl: approvalUrl });
  } catch (err) {
    console.error('Error creating PayPal payment:', err);
    res.status(500).send({ message: 'Error creating PayPal payment', error: err.toString() });
  }
});

// Route to handle PayPal payment capture
app.post('/api/capture-paypal-payment/:paypalOrderID', express.json(), authenticateToken, async (req, res) => {
  const userId = req.userId; 
  const paypalOrderID = req.params.paypalOrderID;
  const request = new paypal.orders.OrdersCaptureRequest(paypalOrderID);
  request.requestBody({});

  try {
    const capture = await paypalClient.execute(request);
    const captureID = capture.result.purchase_units[0].payments.captures[0].id;

    const getMostRecentOrderId = async (userId) => {
      try {
        const user = await User.findById(userId).sort({'orders.date': -1}).limit(1);
        const lastOrder = user.orders.slice(-1)[0];
        return lastOrder.orderId;
      } catch (error) {
        console.error('Error finding the most recent order:', error);
        throw error; // Rethrow the error to be handled by the calling function
      }
    };

    const updateOrderStatusToPaid = async (userId, orderId) => {
      try {
        await User.updateOne(
          { _id: userId, 'orders.orderId': orderId },
          { $set: { 'orders.$.status': 'Paid' } }
        );
      } catch (error) {
        console.error('Error updating order status to Paid:', error);
        throw error; // Rethrow the error to be handled by the calling function
      }
    };

      // Retrieve the most recent order ID
      const orderId = await getMostRecentOrderId(userId);
      
      // Update the order status to 'Paid'
      await updateOrderStatusToPaid(userId, orderId);

    res.json({ captureID });
  } catch (err) {
    console.error('Error capturing payment:', err);
    res.status(500).send({ message: 'Error capturing payment', error: err.message });
  }
});

// Serve static files from the Flutter web app
app.use(express.static(path.join(__dirname, 'web')));

// redirect root to web/index.html
app.get('/', (req, res) => {
  res.redirect('/web/index.html');
});

// Redirect all non-static and non-API requests to Flutter's index.html
// This should be the last route
app.get('*', (req, res, next) => {
  if (req.originalUrl.startsWith('/api')) {
    // Pass control to the next middleware for API routes
    return next();
  }
  // For non-API routes, serve Flutter's index.html
  res.sendFile(path.join(__dirname, 'web/index.html'));
});

// Start the server with HTTP
const server = http.createServer(app);
server.listen(3000, () => {
    console.log('HTTP Server running on port 3000');
});

} catch (error) {
  console.error('Error starting main application:', error);
}