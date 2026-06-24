const express = require('express');
const app = express();
const port = 5000;
const cors = require('cors');
require('dotenv').config();

// Stripe Configuration
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 

// Middleware declarations (Must come BEFORE declaring API routes)
app.use(cors({
  origin: ["http://localhost:3000"], // আপনার ফ্রন্টএন্ড ইউআরএল
  credentials: true
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('RecipeHub Server is Running!');
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
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
     const { payload } = await jwtVerify(token, JWKS);
     req.user = { ...payload, id: payload.sub };
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
    const likesCollection = database.collection("likes");
    const purchasedCollection = database.collection("purchasedRecipes");
    const popularRecipeCollection = database.collection("popularRecipe");
    const featuredRecipesCollection = database.collection("FeaturedRecipes");
    const favoritesCollection = database.collection("favorites");
   
    // ==========================================
    // ১. ইউজারের মোট রেসিপি সংখ্যা ও কারেন্ট প্ল্যান চেক করার API
    // ==========================================
    app.get('/api/my-recipes/count', verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const count = await recipescollection.countDocuments({ userId });

        const userQuery = ObjectId.isValid(userId) ? { _id: new ObjectId(userId) } : { _id: userId };
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
// ইউজারের আইডি অনুযায়ী তার তৈরি সব রেসিপি গেট করার API
// ==========================================
app.get('/api/my-recipes/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // আপনার ডাটাবেজে userId যদি string বা ObjectId হিসেবে সেভ থাকে, সেই অনুযায়ী কুয়েরি হবে
    // এখানে recipescollection থেকে নির্দিষ্ট ইউজারের সব রেসিপি অ্যারে আকারে আনা হচ্ছে
    const myRecipes = await recipescollection.find({ userId: userId }).toArray();
    
    res.status(200).send(myRecipes);
  } catch (error) {
    console.error("Error fetching user recipes:", error);
    res.status(500).send({ error: "Failed to fetch user recipes" });
  }
});

    // ==========================================
    // ২. নতুন রেসিপি যোগ করার API
    // ==========================================
    app.post('/api/recipes', verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const userEmail = req.user.email;

        const user = await usersCollection.findOne({ 
          $or: [ { email: userEmail }, { _id: userId } ] 
        });
        
        const currentCount = await recipescollection.countDocuments({ userId: userId });

        if (user?.plan !== 'pro' && currentCount >= 3) {
          return res.status(403).json({ 
            error: "Limit reached! You cannot post more than 3 recipes. Please pay to unlock unlimited posting." 
          });
        }

        const recipe = { ...req.body, userId };
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
        const { price, packageName, recipeId, userEmail } = req.body;

        let successUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/success?payment=success`;
        let cancelUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment?payment=cancel`;

        if (recipeId) {
          successUrl += `&type=recipe&session_id={CHECKOUT_SESSION_ID}&recipeId=${recipeId}&email=${userEmail}`;
          cancelUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/api/recipes/${recipeId}`;
        }

        const sessionData = {
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: packageName,
                  description: recipeId ? 'Instant lifetime access to this premium recipe blueprint.' : 'Lifetime unlimited recipe posting access.',
                },
                unit_amount: Math.round(price * 100), 
              },
              quantity: 1,
            },
          ],
          mode: 'payment',
          success_url: successUrl,
          cancel_url: cancelUrl,
        };

        if (userEmail) {
          sessionData.customer_email = userEmail;
        }

        const session = await stripe.checkout.sessions.create(sessionData);
        res.status(200).json({ id: session.id, url: session.url });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // ৪. সফল পেমেন্টের পর ট্রানজেকশন সেভ ও প্ল্যান আপডেট API
    // ==========================================
    app.post('/api/payments/confirm', verifyToken, async (req, res) => {
      try {
        const { email, amount, packageName, transactionId } = req.body;
        const userId = req.user.id;

        await paymentsCollection.insertOne({
          userId,
          email: email.toLowerCase().trim(),
          amount,
          packageName,
          transactionId,
          date: new Date()
        });

        const userQuery = ObjectId.isValid(userId) ? { _id: new ObjectId(userId) } : { _id: userId };
        await usersCollection.updateOne(userQuery, { $set: { plan: "pro", updatedAt: new Date() } });

        const sessionsCollection = database.collection("session");
        const sessionQuery = ObjectId.isValid(userId) ? { userId: new ObjectId(userId) } : { userId: userId };
        await sessionsCollection.updateMany(sessionQuery, { $set: { "user.plan": "pro" } });

        res.status(200).json({ success: true, message: "Plan upgraded to PRO" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // ৫. রেসিপি পারচেজ কনফার্ম ও গেট API
    // ==========================================
    app.post('/api/purchased-recipes/confirm', async (req, res) => {
      try {
        const { sessionId, recipeId, email } = req.body;
        const alreadyPurchased = await purchasedCollection.findOne({ sessionId });
        if (alreadyPurchased) {
          return res.status(200).json({ success: true, message: "Already processed" });
        }

        await purchasedCollection.insertOne({
          sessionId,
          recipeId,
          email: email.toLowerCase().trim(),
          purchaseDate: new Date()
        });
        res.status(200).json({ success: true, message: "Purchase confirmed successfully!" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

   app.get('/api/purchased-recipes/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase().trim();
    
    const purchases = await purchasedCollection.aggregate([
      { $match: { email: email } },
      // recipeId-কে সেফলি হ্যান্ডেল করা হচ্ছে
      { 
        $addFields: { 
          recipeObjectId: {
            $cond: {
              if: { $regexMatch: { input: "$recipeId", regex: /^[0-9a-fA-F]{24}$/ } },
              then: { $toObjectId: "$recipeId" },
              else: "$recipeId" // ওল্ড বা স্ট্রিং আইডি হলে সরাসরি বসবে
            }
          }
        } 
      },
      {
        $lookup: {
          from: "recipes",
          let: { rId: "$recipeId", rObjId: "$recipeObjectId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$rObjId"] },
                    { $eq: ["$_id", "$$rId"] }
                  ]
                }
              }
            }
          ],
          as: "recipeDetails"
        }
      },
      // যদি রেসিপি ডিলিট হয়ে যায় বা ম্যাচ না করে, তাও যেন পারচেজ হিস্ট্রি দেখায় (Left Join)
      { $unwind: { path: "$recipeDetails", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: { $ifNull: ["$recipeDetails._id", "$recipeId"] },
          recipeName: { $ifNull: ["$recipeDetails.recipeName", "Unknown Premium Recipe"] },
          imageUrl: { $ifNull: ["$recipeDetails.imageUrl", ""] },
          category: { $ifNull: ["$recipeDetails.category", "Premium"] },
          cuisineType: { $ifNull: ["$recipeDetails.cuisineType", "Exclusive"] },
          purchaseDate: "$purchaseDate",
          sessionId: "$sessionId"
        }
      }
    ]).toArray();
    
    res.status(200).send(purchases);
  } catch (error) {
    console.error("Aggregation Error:", error);
    res.status(500).json({ error: error.message });
  }
});

    // ==========================================
    // ৬. Popular & Featured Recipe APIs
    // ==========================================
    app.get('/popularRecipe', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 8;
        const result = await popularRecipeCollection.find({}).sort({ rank: 1 }).limit(limit).toArray();
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get('/FeaturedRecipes', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 3;
        const result = await featuredRecipesCollection.find({}).limit(limit).toArray();
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // ==========================================
    // 🎯 ৭. অল রেসিপি গেট API (সার্চ, পেজিনেশন এবং অ্যাডমিন প্যানেল কম্বাইন্ড)
    // ==========================================
    app.get('/api/recipes', async (req, res) => {
      try {
        const page = req.query.page ? parseInt(req.query.page) : null;
        const limit = req.query.limit ? parseInt(req.query.limit) : null;
        const search = req.query.search || '';

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

        let allRecipes;
        if (page && limit) {
          const skip = (page - 1) * limit;
          allRecipes = await recipescollection.find(query).skip(skip).limit(limit).toArray();
        } else {
          allRecipes = await recipescollection.find(query).toArray();
        }

        const totalItems = await recipescollection.countDocuments(query);

        // প্রতিটা রেসিপির সাথে অথর ডাটা মার্জ করা
        const recipesWithAuthors = await Promise.all(
          allRecipes.map(async (recipe) => {
            let authorDetails = null;
            if (recipe.userId) {
              try {
                const userQuery = ObjectId.isValid(recipe.userId) ? { _id: new ObjectId(recipe.userId) } : { _id: recipe.userId };
                authorDetails = await usersCollection.findOne(userQuery, { projection: { password: 0 } });
              } catch (err) {
                console.error("User fetch error:", err);
              }
            }
            return {
              ...recipe,
              authorDetails: authorDetails || { name: "Unknown User", email: "No Email" }
            };
          })
        );

        if (page && limit) {
          res.status(200).json({
            recipes: recipesWithAuthors,
            totalItems,
            currentPage: page,
            totalPages: Math.ceil(totalItems / limit)
          });
        } else {
          // ম্যানেজ রেসিপি পেজের জন্য সরাসরি ফুল অ্যারে রিটার্ন করবে
          res.status(200).json(recipesWithAuthors);
        }

      } catch (error) {
        console.error("Global recipes error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // ==========================================
    // ৮. রেসিপি ডিটেইলস, আপডেট এবং ডিলিট API
    // ==========================================
    app.get('/api/recipes/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid ID" });
        const result = await recipescollection.findOne({ _id: new ObjectId(id) });
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.patch('/api/my-recipes/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const filter = { _id: new ObjectId(id) };
        const result = await recipescollection.updateOne(filter, { $set: req.body });
        res.status(200).send({ message: "Updated successfully", result });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.delete('/api/recipes/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        const result = await recipescollection.deleteOne(query);
        if (result.deletedCount === 0) return res.status(404).json({ error: "Not found" });
        res.status(200).json({ success: true, message: "Deleted successfully" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.patch('/api/recipes/:id/feature', async (req, res) => {
      try {
        const { id } = req.params;
        const { isFeatured } = req.body;
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        await recipescollection.updateOne(query, { $set: { isFeatured: isFeatured } });
        res.status(200).json({ success: true, message: "Featured status updated" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // ৯. ফেভারিট ও লাইকস টগল এপিআই সমূহ
    // ==========================================
    app.post('/api/favorites', async (req, res) => {
      try {
        const { userId, recipeId } = req.body;
        const query = { userId, recipeId };
        const existing = await favoritesCollection.findOne(query);

        if (existing) {
          await favoritesCollection.deleteOne(query);
          return res.status(200).send({ success: true, isFavorite: false });
        } else {
          await favoritesCollection.insertOne({ userId, recipeId, createdAt: new Date() });
          return res.status(201).send({ success: true, isFavorite: true });
        }
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

// ==========================================
// ইউজারের আইডি অনুযায়ী তার সব ফেভারিট রেসিপি গেট করার API
// ==========================================
app.get('/api/favorites/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // userId যদি ২৪ অক্ষরের হেক্স স্ট্রিল হয় তবে ওটাকে ObjectId বানাবো, নাহলে স্ট্রিল হিসেবেই থাকবে
    const userQueryId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;

    const favoriteRecipes = await favoritesCollection.aggregate([
      // ১. আইডি স্ট্রিং বা অবজেক্ট যাই হোক—উভয় কন্ডিশনে চেক করা হচ্ছে
      { 
        $match: { 
          $or: [
            { userId: userId },
            { userId: userQueryId }
          ]
        } 
      },
      
      // ২. recipeId সেফ কনভার্সন (আপনার আগের কোড)
      { 
        $addFields: { 
          recipeObjectId: {
            $cond: {
              if: { $regexMatch: { input: "$recipeId", regex: /^[0-9a-fA-F]{24}$/ } },
              then: { $toObjectId: "$recipeId" },
              else: "$recipeId"
            }
          }
        } 
      },
      
      // ৩. 'recipes' কালেকশনের সাথে লুকআপ
      {
        $lookup: {
          from: "recipes",
          let: { rId: "$recipeId", rObjId: "$recipeObjectId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$_id", "$$rObjId"] },
                    { $eq: ["$_id", "$$rId"] }
                  ]
                }
              }
            }
          ],
          as: "recipeDetails"
        }
      },
      
      { $unwind: { path: "$recipeDetails", preserveNullAndEmptyArrays: true } },
      
      // ৪. প্রজেকশন ম্যাপিং
      {
        $project: {
          _id: "$_id",
          userId: "$userId",
          recipeId: "$recipeId",
          recipeName: { $ifNull: ["$recipeDetails.recipeName", "Deleted Recipe"] },
          imageUrl: { $ifNull: ["$recipeDetails.imageUrl", ""] },
          category: { $ifNull: ["$recipeDetails.category", "General"] },
          cuisineType: { $ifNull: ["$recipeDetails.cuisineType", "International"] },
          difficultyLevel: { $ifNull: ["$recipeDetails.difficultyLevel", "Easy"] }
        }
      }
    ]).toArray();

    res.status(200).send(favoriteRecipes);
  } catch (error) {
    console.error("Error fetching favorite recipes:", error);
    res.status(500).json({ error: "Failed to fetch favorite recipes" });
  }
});


// ==========================================
// ইউজারের আইডি অনুযায়ী তার লাইক করা সব রেসিপির লিস্ট গেট করার API
// ==========================================
app.get('/api/likes/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    // লিকস কালেকশন থেকে ওই ইউজারের সব ডেটা অ্যারে আকারে আনা হচ্ছে
    const userLikes = await likesCollection.find({ userId: userId }).toArray();
    res.status(200).send(userLikes);
  } catch (error) {
    console.error("Error fetching user likes:", error);
    res.status(500).json({ error: "Failed to fetch likes status" });
  }
});

    app.post('/api/likes', async (req, res) => {
      try {
        const { userId, recipeId } = req.body;
        const recipeObjectId = new ObjectId(recipeId);

        const existingLike = await likesCollection.findOne({ 
          userId, $or: [ { recipeId }, { recipeId: recipeObjectId } ]
        });

        if (existingLike) {
          await likesCollection.deleteOne({ _id: existingLike._id });
          await recipescollection.updateOne({ _id: recipeObjectId }, { $inc: { likesCount: -1 } });
          return res.status(200).json({ success: true, hasLiked: false });
        } else {
          await likesCollection.insertOne({ userId, recipeId, createdAt: new Date() });
          await recipescollection.updateOne({ _id: recipeObjectId }, { $inc: { likesCount: 1 } });
          return res.status(200).json({ success: true, hasLiked: true });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // ১০. Admin Panel - User Status API
    // ==========================================
// ==========================================
// ১০. Admin Panel - Get All Users API
// ==========================================
app.get('/api/users', async (req, res) => {
  try {
    // কালেকশন থেকে পাসওয়ার্ড ছাড়া সব ইউজারের ডেটা আনা হচ্ছে
    const result = await usersCollection.find({}).project({ password: 0 }).toArray();
    res.status(200).send(result);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});




    app.patch('/api/users/:userId/status', async (req, res) => {
      try {
        const { userId } = req.params;
        const { status } = req.body; 
        const query = ObjectId.isValid(userId) ? { _id: new ObjectId(userId) } : { _id: userId };
        
        await usersCollection.updateOne(query, { $set: { status, statusUpdatedAt: new Date() } });
        res.status(200).json({ success: true, message: "Status updated" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });




    // MongoDB Ping
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");
  } catch (err) {
    console.error("Database connection failure:", err);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});