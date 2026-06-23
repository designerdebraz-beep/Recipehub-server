const mongoose = require('mongoose');

const LikeSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true
    },
    recipeId: {
        type: String,
        required: true
    }
}, { timestamps: true });

LikeSchema.index({ userId: 1, recipeId: 1 }, { unique: true });

const LikeModel = mongoose.models.Like || mongoose.model('Like', LikeSchema);
module.exports = LikeModel;