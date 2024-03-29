import { Resolver, Query, Arg, Args, FieldResolver, Root, Mutation, Authorized, Ctx, ID, Subscription, PubSub, PubSubEngine, ResolverFilterData } from "type-graphql";
import { TweetConnection } from "../paginatedResponse";
import PaginationArgs from "../args&inputs/pagination.args";
import { getPaginatedRowsFromTable } from "../../utils";
import Tweet from "../models/tweet";
import User from "../models/user";
import db from "../../database";
import { userColumns } from "./user";
import NewTweetInput from "../args&inputs/newTweet.input";
import { Context } from "../../types";
import GenericError from "../genericError";

@Resolver(of => Tweet)
class TweetResolvers {

  @FieldResolver(returns => User, { description: 'The actor who authored the Tweet.', complexity: 4 })
  async author(
    @Root() { user_id }: Tweet
  ): Promise<User> {
    return await db.select(userColumns).from('users').where({ id: user_id }).first() as User
  }

  @FieldResolver(returns => Tweet, { nullable: true, description: 'The original tweet associated with this node.', complexity: 4 })
  async replyTweet(
    @Root() { reply_to }: Tweet
  ): Promise<Tweet | null> {
    if (reply_to === null) return;
    else {
      return await db.select('*').from('tweets').where({ id: reply_to }).first() as Tweet
    }
  }

  @FieldResolver(returns => TweetConnection, { description: 'Get all tweets that are marked as a response from a specific tweet.', complexity: 10 })
  async replies(
    @Root() originalTweet: Tweet,
    @Args() { first, offset, after }: PaginationArgs
  ) {
    return await getPaginatedRowsFromTable({
      tableName: 'tweets',
      columns: '*',
      where: [`"reply_to" = ${originalTweet.id}`],
      after,
      first,
      offset,
    });
  }

  @FieldResolver(returns => Number, { description: 'Count how many likes a tweet has.', complexity: 4 })
  async likesCount(
    @Root() tweetInfos: Tweet,
  ): Promise<number> {
    try {
      return await db.select('*')
        .from('tweets')
        .innerJoin('tweets_likes', 'tweets.id', '=', 'tweets_likes.tweet_id')
        .where('tweets.id', '=', tweetInfos.id)
        .then(res => res.length || 0) as number
    }
    catch(err) {
      throw new GenericError('UNKNOWN', 'There was a problem counting the total number of likes.');
    }
  }

  @FieldResolver(returns => Number, { description: 'Count how many replies a tweet has.', complexity: 4 })
  async repliesCount(
    @Root() tweetInfos: Tweet,
  ): Promise<number> {
    try {
      return await db.select('*')
        .from('tweets')
        .where('reply_to', '=', tweetInfos.id)
        .then(res => res.length || 0) as number
    }
    catch(err) {
      throw new GenericError('UNKNOWN', 'There was a problem counting the total number of replies.');
    }
  }

  @FieldResolver(returns => [User], { description: 'A list of users who have liked the tweet', complexity: 4 })
  async peopleWhoLiked(
    @Root() tweetInfos: Tweet
  ): Promise<User[]> {
    try {
      return await db.select(userColumns.map(c => `users.${c}`))
        .from('users')
        .innerJoin('tweets_likes', 'users.id', '=', 'tweets_likes.user_id')
        .where('tweet_id', '=', tweetInfos.id)
    }
    catch(err) {
      throw new GenericError('UNKNOWN', 'There was a problem fetching users who liked this tweet.');
    }
  }
  
  @FieldResolver(returns => Boolean, { description: 'Whether or not the authenticated user has liked the tweet.', complexity: 4 })
  async viewerHasLiked(
    @Root() tweetInfos: Tweet,
    @Ctx() { currentUserId } : Context
  ): Promise<boolean> {
    // If no user is logged in, return false
    if (currentUserId === null) return false;

    try {
      return await db.count('*')
        .from('tweets_likes')
        .where('tweet_id', '=', tweetInfos.id)
        .andWhere('user_id', '=', currentUserId)
        .then(res => Number(res[0].count) > 0)
    }
    catch(err) {
      throw new GenericError('UNKNOWN', 'There was a problem determining whether or not the current user has liked the tweet.');
    }
  }


  @Query(returns => Tweet, { description: 'Get a specific tweet by id.', complexity: 1 })
  async tweet(
    @Arg('id', type => ID) id: string,
  ): Promise<Tweet> {
    const tweet = await db.select('*').from('tweets').where({ id }).first() as Tweet

    return tweet
  }


  @Query(returns => TweetConnection, { description: 'Search latest tweets.', complexity: 10 })
  async tweets(
    @Args() { first, offset, after }: PaginationArgs,
    @Arg('fromUser', { nullable: true }) fromUser?: string,
  ) {
    return await getPaginatedRowsFromTable({
      tableName: 'tweets',
      columns: '*',
      ...(typeof fromUser !== 'undefined' ? {
        where: [`"user_id" = ${fromUser}`]
      } : {}),
      after,
      first,
      offset,
    });
  }


  @Query(returns => TweetConnection, { description: 'Search for replies to a specific tweet.', complexity: 10 })
  async thread(
    @Args() { first, offset, after }: PaginationArgs,
    @Arg('id', type => ID, { description : 'Id of the original tweet.' }) id: string,
  ) {
    return await getPaginatedRowsFromTable({
      tableName: 'tweets',
      columns: '*',
      ...(typeof id !== 'undefined' ? {
        where: [`"reply_to" = ${id}`]
      } : {}),
      after,
      first,
      offset,
    });
  }


  @Authorized(['admin', 'user'])
  @Mutation(returns => Tweet, { description: 'Create a new tweet.', complexity: 5 })
  async createTweet(
    @Arg('input') input: NewTweetInput,
    @Ctx() { currentUserId }: Context,
    @PubSub() pubSub: PubSubEngine
  ): Promise<Tweet> {
    const newTweet = await db.insert({
      ...input,
      user_id: currentUserId,
      created_at: new Date().toISOString()
    })
      .into('tweets')
      .returning('*')
      .then(res => res[0])

    const topicName = (typeof input.reply_to === 'undefined' || input.reply_to === null) ? 'NEW_TWEET' : 'NEW_REPLY'
    await pubSub.publish(topicName, newTweet)

    return newTweet;
  }


  @Authorized(['admin', 'user'])
  @Mutation(returns => String, { description: 'Delete tweet by id. Returns "Done." if successful.', complexity: 5 })
  async deleteTweet(
    @Arg('id', type => ID) id: string,
    @Ctx() { currentUserId }: Context
  ): Promise<string> {
    const tweet = await db.select('*').from('tweets').where({ id }).first() as Tweet

    if (typeof tweet === 'undefined') throw new GenericError('NOT_FOUND', 'No tweets with this id were found.');
    if (currentUserId != tweet.user_id) throw new GenericError('FORBIDDEN', 'You are not allowed to perform this action!');

    // Delete tweet
    const result = await db.delete().from('tweets').where({ id })
    
    if (result === 0) throw new GenericError('UNKNOWN', 'There was a problem deleting Tweet.');

    return `Done.`
  }


  @Subscription(returns => Tweet, {
    description: 'Listen for new tweets.',
    topics: 'NEW_TWEET',
    filter: ({ args, payload }: ResolverFilterData<Tweet>) => {
      // If "fromUser" is set, filter by user id in tweets
      if (typeof args.fromUser !== 'undefined') return payload.user_id == args.fromUser;
      else return true;
    },
    complexity: 30
  })
  async tweetAdded(
    @Root() newTweetPayload: Tweet,
    @Arg('fromUser', type => ID, { nullable: true, description: 'The Node ID of the user.' }) fromUser?: string,
  ) {
    return newTweetPayload
  }


  @Subscription(returns => Tweet, {
    description: 'Listen for new replies to a specific tweet.',
    topics: 'NEW_REPLY',
    filter: ({ args, payload }: ResolverFilterData<Tweet>) => {
      // Filter by reply_to in tweet
      return payload.reply_to == args.toTweet;
    },
    complexity: 30
  })
  async replyAdded(
    @Root() newTweetPayload: Tweet,
    @Arg('toTweet', type => ID, { description: 'The Node ID of the original tweet.' }) repliesTo?: string,
  ) {
    return newTweetPayload
  }
}

export default TweetResolvers