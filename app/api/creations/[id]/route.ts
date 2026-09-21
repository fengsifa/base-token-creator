import { NextRequest,NextResponse } from "next/server";
import { updateTokenRecord } from "../../../../lib/database";
export async function PATCH(request:NextRequest,{params}:{params:{id:string}}){try{const data=await updateTokenRecord(params.id,await request.json());return NextResponse.json({record:Array.isArray(data)?data[0]:data});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Database error"},{status:503});}}
