import { mongoDB_connect } from "@/app/helpers/helper";
import { userSchema } from "@/app/models/userModel";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/app/lib/session";

export async function GET(request) {
    const userId = await getSessionUserId(request);
    if (!userId) return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
    await mongoDB_connect();
    const search = (request.nextUrl.searchParams.get('search') || '').trim().slice(0, 100);
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedSearch, 'i');

    const pipeline = [
        {
            $addFields: {
                nickname_values: {
                    $map: {
                        input: { $objectToArray: { $ifNull: ['$nicknames', {}] } },
                        as: 'nickname',
                        in: { $toString: '$$nickname.v' }
                    }
                }
            }
        },
        {
            $match: {
                status: 1,
                ...(search
                    ? {
                        $or: [
                            { name: { $regex: searchRegex } },
                            { email: { $regex: searchRegex } },
                            { phone: { $regex: searchRegex } },
                            { nickname_values: { $regex: searchRegex } },
                        ],
                    }
                    : {})
            }
        },
        {
            $project: {
                _id:0,
                user_id: "$_id",
                name: 1,
                photo: 1,
                is_checked: { $literal: false },
                is_admin: { $literal: false },
            },
        },
        { $limit: 200 },
    ];

    let data = await userSchema.aggregate(pipeline);

    return NextResponse.json({ success: true, data });
}