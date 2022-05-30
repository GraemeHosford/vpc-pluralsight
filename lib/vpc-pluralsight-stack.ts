import {RemovalPolicy, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";

export class VpcPluralsightStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        /* Create a VPC to act as public facing part of infra */
        const publicVpc = new ec2.Vpc(this, "PublicVpc", {
            vpcName: "web-vpc",
            cidr: "10.1.0.0/16",
            // If left undefined CDK tries to create default subnets which causes conflict and errors
            // Empty array prevents this
            subnetConfiguration: []
        });
        publicVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a public subnet which holds the public facing parts of a web app */
        const publicSubnet = new ec2.Subnet(this, "PublicSubnet", {
            vpcId: publicVpc.vpcId,
            availabilityZone: "eu-west-1a",
            cidrBlock: "10.1.254.0/24"
        });
        publicSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a route table tied to the public VPC */
        const publicRouteTable = new ec2.CfnRouteTable(this, "PublicRouteTable", {
            vpcId: publicVpc.vpcId
        });
        publicRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicSubnetRouteTableAssociation =
            new ec2.CfnSubnetRouteTableAssociation(this, "PublicRouteTableSubnetAssociation", {
                subnetId: publicSubnet.subnetId,
                routeTableId: publicRouteTable.attrRouteTableId
            });
        publicSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create an internet gateway which allow public VPC to access the outside world and vice versa */
        const publicInternetGateway = new ec2.CfnInternetGateway(this, "PublicInternetGateway");
        publicInternetGateway.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicVpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, "PublicVpcIgwAttachment", {
            vpcId: publicVpc.vpcId,
            internetGatewayId: publicInternetGateway.attrInternetGatewayId
        });
        publicVpcIgwAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* cidr block 0.0.0.0/0 means all IPV4 traffic should get access to internet ingress and egress */
        const route = new ec2.CfnRoute(this, "PublicInternetAccessRoute", {
            routeTableId: publicRouteTable.attrRouteTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: publicInternetGateway.attrInternetGatewayId
        });
        route.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }
}
