const express = require('express');
const app = express();
const port = 5000;
const cors = require('cors');
require('dotenv').config();

    // Stripe Configuration
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
// Middleware declarations (Must come BEFORE declaring API routes)
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

// Token Verification Middleware
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("Auth Header:", authHeader);

  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
     const { payload } = await jwtVerify(token, JWKS);
    console.log("Token Payload:", payload);
      req.user = { ...payload, id: payload.sub };
   // Attach user data to request
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error);
    return res.status(401).json({ msg: "Unauthorized" });
  }
};

async function run() {
  try {
    await client.connect();

    const database = client.db("RecipeHub");
    const recipescollection = database.collection("recipes");
    const paymentsCollection = database.collection("payments");
    const usersCollection = database.collection("user");

    // ==========================================
    // ১. ইউজারের মোট রেসিপি সংখ্যা ও কারেন্ট প্ল্যান চেক করার API
    // ==========================================
app.get('/api/my-recipes/count', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await recipescollection.countDocuments({ userId });

    // ✅ Convert to ObjectId
    const userQuery = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : { _id: userId };
    const user = await usersCollection.findOne(userQuery);

    res.status(200).send({
      success: true,
      count,
      plan: user?.plan || "free"
    });
  } catch (error) {
    res.status(500).send({ error: "Failed to get recipe count" });
  }
});

    // ==========================================
    // ২. নতুন রেসিপি যোগ করার API (Free-তে ৩টি পোস্টের লিমিট ও PRO-তে আনলিমিটেড)
    // ==========================================
    app.post('/api/recipes', verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const userEmail = req.user.email;

        console.log("Attempting post for User ID:", userId);

        // ডাটাবেজ থেকে ইউজারের বর্তমান প্ল্যান চেক করা
        const user = await usersCollection.findOne({ 
          $or: [
            { email: userEmail },
            { _id: userId }
          ] 
        });
        
        // ডাটাবেজে এই ইউজারের বর্তমান রেসিপি সংখ্যা চেক করা
        const currentCount = await recipescollection.countDocuments({ userId: userId });

        // কন্ডিশন: প্রো না হলে এবং অলরেডি ৩টি বা তার বেশি রেসিপি থাকলে ব্লক হবে
        if (user?.plan !== 'pro' && currentCount >= 3) {
          return res.status(403).json({ 
            error: "Limit reached! You cannot post more than 3 recipes. Please pay to unlock unlimited posting." 
          });
        }

        const recipe = {
          ...req.body,
          userId
        };

        const result = await recipescollection.insertOne(recipe);
        res.status(201).send(result);
        
      } catch (error) {
        console.error("Error saving recipe:", error);
        res.status(500).send({ error: "Could not save the recipe." });
      }
    });



    // ==========================================
    // ৩. Stripe Checkout Session তৈরির API
    // ==========================================
    app.post('/api/create-checkout-session', async (req, res) => {
      try {
        const { price, packageName } = req.body;

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: packageName,
                  description: 'Lifetime unlimited recipe posting access.',
                },
                unit_amount: Math.round(price * 100), 
              },
              quantity: 1,
            },
          ],
          mode: 'payment',
          // সাকসেস ইউআরএল-এ কুয়েরি প্যারামিটার যুক্ত করা হলো যাতে ফ্রন্টএন্ড সহজে ডিটেক্ট করতে পারে
          success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/success?payment=success`, 
          cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment?payment=cancel`,
        });

        res.status(200).json({ id: session.id, url: session.url });
      } catch (error) {
        console.error("Stripe Session Error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ==================================================
    // ৪. সফল পেমেন্টের পর ট্রানজেকশন সেভ ও প্ল্যান আপডেট API (ACTIVE)
    // ==================================================
   // ==================================================
    // ৪. সফল পেমেন্টের পর ট্রানজেকশন সেভ ও প্ল্যান আপডেট API (SECURED & FIXED)
    // ==================================================
app.post('/api/payments/confirm', verifyToken, async (req, res) => {
  try {
    const { email, amount, packageName, transactionId } = req.body;
    const userId = req.user.id; // string from token

    // 1. Save payment record
    await paymentsCollection.insertOne({
      userId,
      email: email.toLowerCase().trim(),
      amount,
      packageName,
      transactionId,
      date: new Date()
    });

    // 2. Update the user collection
    const userQuery = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : { _id: userId };

    const updateResult = await usersCollection.updateOne(
      userQuery,
      { $set: { plan: "pro", updatedAt: new Date() } }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // 3. 🔥 Update all sessions for this user (fixed query)
    const sessionsCollection = database.collection("session");
    const sessionQuery = ObjectId.isValid(userId)
      ? { userId: new ObjectId(userId) }
      : { userId: userId };

    const sessionUpdateResult = await sessionsCollection.updateMany(
      sessionQuery,
      { $set: { "user.plan": "pro" } }
    );

    console.log(`Updated ${sessionUpdateResult.modifiedCount} session(s) for user ${userId}`);

    res.status(200).json({ success: true, message: "Plan upgraded to PRO" });
  } catch (error) {
    console.error("Payment confirmation error:", error);
    res.status(500).json({ error: error.message });
  }
});

    // ==========================================
    // ৫. Popular Recipe APIs
    // ==========================================
    const popularRecipeCollection = database.collection("popularRecipe");

    app.get('/popularRecipe', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 8;
        const result = await popularRecipeCollection
          .find({})
          .sort({ rank: 1 }) 
          .limit(limit)
          .toArray();
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch popular recipes", error: error.message });
      }
    });

    app.get('/popularRecipe/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid recipe ID format" });
        }
        const result = await popularRecipeCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).send({ error: "Recipe not found" });
        }
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ error: "Could not retrieve recipe details." });
      }
    });

    // ==========================================
    // ৬. Featured Recipe APIs
    // ==========================================
    const featuredRecipesCollection = database.collection("FeaturedRecipes");

    app.get('/FeaturedRecipes', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 3;
        const result = await featuredRecipesCollection.find({}).limit(limit).toArray();
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch featured recipes", error: error.message });
      }
    });

    app.get('/FeaturedRecipes/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid featured recipe ID format" });
        }
        const query = { _id: new ObjectId(id) };
        const result = await featuredRecipesCollection.findOne(query);
        if (!result) {
          return res.status(404).send({ error: "Featured recipe not found" });
        }
        res.status(200).send(result);
      } catch (error) {
        console.error("Failed to fetch featured recipe:", error);
        res.status(500).send({ error: "Could not retrieve featured recipe details." });
      }
    });

    // ==========================================
    // ৭. User Specific & Global Recipes APIs
    // ==========================================
    app.get('/api/my-recipes/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const result = await recipescollection.find({ userId }).toArray();
        res.status(200).send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch recipes", error: error.message });
      }
    });


app.patch('/api/my-recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body; // ফ্রন্টএন্ড থেকে পাঠানো নতুন ডাটা
    
    // MongoDB ObjectId ইম্পোর্ট করা থাকতে হবে: const { ObjectId } = require('mongodb');
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: updatedData,
    };

    const result = await recipescollection.updateOne(filter, updateDoc);
    
    if (result.modifiedCount === 0) {
      return res.status(404).send({ message: "No changes made or recipe not found" });
    }

    res.status(200).send({ message: "Recipe updated successfully", result });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update recipe", error: error.message });
  }
});


app.delete('/api/my-recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: new ObjectId(id) };
    
    const result = await recipescollection.deleteOne(query);
    
    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Recipe not found" });
    }

    res.status(200).send({ message: "Recipe deleted successfully", result });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to delete recipe", error: error.message });
  }
});



    app.get('/api/recipes', async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const skip = (page - 1) * limit;
        
        let query = {};
        if (search) {
          query = {
            $or: [
              { recipeName: { $regex: search, $options: 'i' } },
              { cuisineType: { $regex: search, $options: 'i' } },
              { category: { $regex: search, $options: 'i' } }
            ]
          };
        }
        
        const [recipes, totalItems] = await Promise.all([
          recipescollection.find(query).skip(skip).limit(limit).toArray(),
          recipescollection.countDocuments(query)
        ]);
        
        res.status(200).send({
          recipes,
          totalItems,
          currentPage: page,
          totalPages: Math.ceil(totalItems / limit)
        });
      } catch (error) {
        console.error("Failed to fetch recipes:", error);
        res.status(500).send({ error: "Could not retrieve recipes." });
      }
    });

    app.get('/api/recipes/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid recipe ID format" });
        }
        const query = { _id: new ObjectId(id) };
        const result = await recipescollection.findOne(query);
        if (!result) {
          return res.status(404).send({ error: "Recipe not found" });
        }
        res.status(200).send(result);
      } catch (error) {
        console.error("Failed to fetch recipe:", error);
        res.status(500).send({ error: "Could not retrieve recipe details." });
      }
    });

    // MongoDB Ping
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (err) {
    console.error("Database connection failure:", err);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});